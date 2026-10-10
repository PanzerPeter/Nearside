/*
  Nearside — the server's timestamps, a question that stays asked, and
  attachments that leave with their message

  Applied after 0061. One function replaces another, four triggers added and
  one re-pointed, two functions replaced, one new trigger function on two
  tables, and one storage policy and one CHECK constraint replaced. Safe to re-run.

  1. `created_at` is the server's on every table a rate limit counts.
     0057 stamped `room_messages.created_at` on insert and left the rest
     writable. Every flood guard here counts rows with
     `created_at > now() - interval`, so a client that dated its inserts to
     2000 was never counted: unlimited friend requests to any account it had an
     id for, unlimited messages and reactions to a friend. On `messages` the
     column is also what read receipts and the thread's order compare, which
     the body guard already said when it froze it on UPDATE — and left open on
     INSERT. One function now, `stamp_created_at()`, and
     `room_messages_stamp_created()` goes: it was the same three lines.

  2. A sealed exchange's question cannot be re-sealed. `sealed_prompt` was
     frozen "because it would change what the answers beneath it were
     answering", and the text it marks was not: a modified client could wait
     for the answer and then swap the question above it. Cancelling (a
     tombstone) stays allowed.

  3. An attachment leaves with its message. A delete, the media trim and any
     other write that takes `media_path` or `media_thumb_path` off a row now
     deletes the object it named, in the same transaction — but only an object
     the row's sender uploaded. The 1:1 client removed the full-size file and
     forgot the preview; a group removed neither, and a room folder has no
     DELETE policy, so every deleted group attachment stayed in the bucket for
     good. The owner check is what keeps this from being a way round that
     policy: a member who repoints their own row at somebody else's file and
     then clears it deletes nothing.

  4. In a 1:1 folder you delete what you uploaded, not what you were sent.
     The old policy let either participant delete any object in the pair's
     folder — the other person's photos from both histories, and their chat
     background. The room section of storage/setup.sql already refused this
     for groups for exactly that reason. `owner` and `owner_id` are both
     checked: the platform writes both, and which one an old object carries
     depends on when it was uploaded.

  5. A sealed question can be withdrawn. Cancelling is the ordinary delete,
     which strips the body, and `sealed_prompt_shape` demanded a body on every
     prompt row — tombstones included — so every cancel since 0032 was refused
     by the database and surfaced as "could not delete". Tombstones are exempt
     now, as `view_once_shape` already made them.
*/

-- ---------------------------------------------------------------------------
-- 1. created_at, stamped
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stamp_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_created_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_stamp_created ON public.messages;
CREATE TRIGGER messages_stamp_created
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_at();

DROP TRIGGER IF EXISTS message_reactions_stamp_created ON public.message_reactions;
CREATE TRIGGER message_reactions_stamp_created
  BEFORE INSERT ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_at();

DROP TRIGGER IF EXISTS room_message_reactions_stamp_created ON public.room_message_reactions;
CREATE TRIGGER room_message_reactions_stamp_created
  BEFORE INSERT ON public.room_message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_at();

DROP TRIGGER IF EXISTS friendships_stamp_created ON public.friendships;
CREATE TRIGGER friendships_stamp_created
  BEFORE INSERT ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_at();

DROP TRIGGER IF EXISTS room_messages_stamp_created ON public.room_messages;
CREATE TRIGGER room_messages_stamp_created
  BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_created_at();

DROP FUNCTION IF EXISTS public.room_messages_stamp_created();

-- ---------------------------------------------------------------------------
-- 2. A question stays the question that was answered
-- ---------------------------------------------------------------------------

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
  -- The answers beneath a question answer the text it had. Withdrawing it is a
  -- tombstone, and stays allowed.
  IF OLD.sealed_prompt
     AND NEW.deleted_at IS NULL
     AND (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
          OR NEW.nonce IS DISTINCT FROM OLD.nonce) THEN
    RAISE EXCEPTION 'a sealed question cannot be edited';
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

-- 5. A withdrawn question is a tombstone, and a tombstone has no body.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS sealed_prompt_shape;
ALTER TABLE public.messages
  ADD CONSTRAINT sealed_prompt_shape CHECK (
    NOT sealed_prompt
    OR deleted_at IS NOT NULL
    OR (ciphertext IS NOT NULL AND media_path IS NULL AND user_id <> receiver_id)
  );

-- ---------------------------------------------------------------------------
-- 3. An attachment leaves with its message
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drop_replaced_media()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  sender uuid;
  doomed text[];
  previous text;
BEGIN
  -- Two statements rather than one expression: plpgsql resolves a record's
  -- field when the statement runs, and `messages` has no `sender_id`.
  IF TG_TABLE_NAME = 'messages' THEN
    sender := OLD.user_id;
  ELSE
    sender := OLD.sender_id;
  END IF;

  doomed := array_remove(ARRAY[
    CASE WHEN NEW.media_path IS DISTINCT FROM OLD.media_path THEN OLD.media_path END,
    CASE WHEN NEW.media_thumb_path IS DISTINCT FROM OLD.media_thumb_path
         THEN OLD.media_thumb_path END
  ], NULL);
  IF cardinality(doomed) = 0 THEN
    RETURN NULL;
  END IF;

  -- The Storage API's own flag (0054), transaction-local, and put back after.
  previous := current_setting('storage.allow_delete_query', true);
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects o
   WHERE o.bucket_id = 'chat-media'
     AND o.name = ANY (doomed)
     AND (o.owner = sender OR o.owner_id = sender::text);
  PERFORM set_config('storage.allow_delete_query', coalesce(previous, 'false'), true);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.drop_replaced_media() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_drop_replaced_media ON public.messages;
CREATE TRIGGER messages_drop_replaced_media
  AFTER UPDATE OF media_path, media_thumb_path ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.drop_replaced_media();

DROP TRIGGER IF EXISTS room_messages_drop_replaced_media ON public.room_messages;
CREATE TRIGGER room_messages_drop_replaced_media
  AFTER UPDATE OF media_path, media_thumb_path ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.drop_replaced_media();

-- ---------------------------------------------------------------------------
-- 4. Delete what you uploaded
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "chat_media_delete_participant" ON storage.objects;
CREATE POLICY "chat_media_delete_participant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND (select auth.uid())::text IN (
      split_part((storage.foldername(name))[1], '_', 1),
      split_part((storage.foldername(name))[1], '_', 2)
    )
    AND (owner = (select auth.uid()) OR owner_id = (select auth.uid())::text)
  );
