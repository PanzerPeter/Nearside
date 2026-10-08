/*
  Nearside — view-once photos and videos

  Applied after 0057. Two columns on `messages`, one constraint, one function,
  and two trigger functions replaced whole.

  A view-once attachment is an ordinary sealed attachment that the server
  takes back after its one opening. `consume_view_once()` is the only way
  that happens: it is called by the recipient's app when the viewer closes,
  stamps `viewed_at`, clears the row's sealed file key, and deletes the object
  from Storage. After that the bytes are gone from the server and nothing on
  the row could open them if they were not.

  What this does NOT promise, and the app must not claim it does:
  - A recipient running a modified app can keep the bytes, or never call the
    function at all. The protocol hands them the key; it cannot then take the
    memory of it back.
  - A second phone's camera defeats every screenshot block there is.
  What it does promise is that an honest client shows the picture once, and
  that the server stops holding it the moment that happens.

  The shape constraint keeps the row honest about what it is:
  - image or video only, because a voice note "once" is a different feature;
  - no thumbnail, because the small sealed copy would outlive the deletion and
    the bubble draws from it;
  - no caption, because a caption is a body and bodies are kept;
  - never forwarded, never a sealed prompt, never the self-chat.

  `view_once` is frozen after insert, and `viewed_at` can only be written by
  the function — a sender who could clear it could show the photo again, and a
  recipient who could set it without the delete would leave the object behind.
*/

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS view_once_shape;
ALTER TABLE public.messages ADD CONSTRAINT view_once_shape CHECK (
  NOT view_once
  OR deleted_at IS NOT NULL
  OR (media_type IN ('image', 'video')
      AND media_thumb_path IS NULL
      AND ciphertext IS NULL
      AND NOT forwarded
      AND NOT sealed_prompt
      AND user_id <> receiver_id)
);

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS viewed_needs_view_once;
ALTER TABLE public.messages ADD CONSTRAINT viewed_needs_view_once CHECK (
  viewed_at IS NULL OR view_once
);

CREATE OR REPLACE FUNCTION public.messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'messages.user_id and messages.receiver_id are immutable';
  END IF;
  IF NEW.forwarded IS DISTINCT FROM OLD.forwarded THEN
    RAISE EXCEPTION 'messages.forwarded is immutable';
  END IF;
  IF NEW.sealed_prompt IS DISTINCT FROM OLD.sealed_prompt THEN
    RAISE EXCEPTION 'messages.sealed_prompt is immutable';
  END IF;
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
    RAISE EXCEPTION 'messages.reply_to_id is immutable';
  END IF;
  IF NEW.view_once IS DISTINCT FROM OLD.view_once THEN
    RAISE EXCEPTION 'messages.view_once is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.messages_body_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be restored';
    END IF;
    IF NEW.ciphertext IS NOT NULL
       OR NEW.media_path IS NOT NULL
       OR NEW.media_thumb_path IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be given a new body';
    END IF;
  END IF;

  IF NEW.deleted_at IS NULL
     AND (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
          OR NEW.media_path IS DISTINCT FROM OLD.media_path
          OR NEW.media_thumb_path IS DISTINCT FROM OLD.media_thumb_path) THEN
    NEW.edited_at := now();
  END IF;

  -- Opened is final, and only consume_view_once() may say so. It sets the
  -- flag below for its own transaction; any other write keeps the old value,
  -- and an opened row cannot be handed a key or an object again.
  IF current_setting('nearside.consume_view_once', true) IS DISTINCT FROM 'on' THEN
    NEW.viewed_at := OLD.viewed_at;
  END IF;
  IF OLD.viewed_at IS NOT NULL
     AND NEW.deleted_at IS NULL
     AND (NEW.media_key_ciphertext IS NOT NULL
          OR NEW.media_path IS DISTINCT FROM OLD.media_path) THEN
    RAISE EXCEPTION 'an opened view-once message cannot be given a new attachment';
  END IF;

  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

/*
  The one opening. Idempotent: a second call, a call for a message that is
  not view-once, or a call from anybody but the recipient changes nothing and
  says nothing — the viewer calls it on close, and a retry after a lost
  response must not raise.
*/
CREATE OR REPLACE FUNCTION public.consume_view_once(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  path text;
BEGIN
  SELECT m.media_path INTO path
    FROM public.messages m
   WHERE m.id = target
     AND m.receiver_id = (SELECT auth.uid())
     AND m.view_once
     AND m.viewed_at IS NULL
     AND m.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM set_config('nearside.consume_view_once', 'on', true);
  UPDATE public.messages
     SET viewed_at = now(),
         media_key_ciphertext = NULL,
         media_key_nonce = NULL
   WHERE id = target;
  PERFORM set_config('nearside.consume_view_once', 'off', true);

  -- The key is gone from the row above, so the bytes are already unopenable;
  -- this takes them off the server too. Same flag as expire_messages() (0054).
  IF path IS NOT NULL THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects WHERE bucket_id = 'chat-media' AND name = path;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_view_once(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_view_once(uuid) TO authenticated;
