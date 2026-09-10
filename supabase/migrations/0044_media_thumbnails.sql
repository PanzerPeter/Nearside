/*
  Nearside — a picture in a conversation stops costing the whole picture

  Applied after 0043. Two columns, one on `messages` and one on
  `room_messages`, plus the room signature version that covers the new one.

  Why it exists. An attachment had exactly one object: the image, capped at a
  1920px long edge, typically two to five hundred kilobytes. The bubble in the
  thread is about two hundred pixels wide, and it was drawn by downloading and
  decrypting that whole object. A video bubble was worse — it painted its first
  frame by fetching the video. On a good link nobody notices; on a train, or on
  a metered plan, scrolling a conversation of photographs spends megabytes to
  draw thumbnails, and the thread stalls behind attachments nobody has opened.

  So a send now uploads a second, small object beside the first: the same
  picture at a 360px long edge, or a single frame grabbed from the video. The
  thread draws that; the full object is fetched only when somebody taps it
  open, pins it, or forwards it.

  What is NOT in this migration, deliberately:

  - No second key. The thumbnail is sealed with the *same* per-file key as the
    object it belongs to (`media_key_ciphertext`), so anyone who can open one
    can open the other and nobody else can open either. A separate key would be
    a second thing to seal, a second thing to rotate and a second way for a row
    to be half-readable, to protect a smaller copy of a picture the same people
    are already allowed to see.

  - No columns on the *pins* table. A pin keeps the full object, which is what
    a pin is for.

  Backwards compatibility. `media_thumb_path` is null on every row written
  before this, and null means what it has always meant: draw the full object.
  Nothing has to be backfilled, and an old client — which never selects the
  column — keeps working unchanged against a database that has it.

  The room signature. `room_messages.media_thumb_path` is inside the signed
  payload, as version 3. It has to be: the signature is the only thing that
  establishes authorship of a room message to a client, and a column outside it
  is a column the server can repoint on somebody else's message and have every
  client still draw it under their name. Version 2 rows keep verifying under
  version 2 forever — see `signedPayloadV3` in src/lib/crypto/seal.ts, which
  appends rather than reorders, for why that is safe. `sig_v` has no CHECK
  constraining its values and needs none; a version this client cannot build a
  payload for is refused by the client, which is where the decision belongs.
*/

-- ---------------------------------------------------------------- messages

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_thumb_path text;

DO $$
BEGIN
  -- A thumbnail with nothing to be a thumbnail of is a dangling object: the
  -- bucket would keep bytes no attachment points at, and the trim that cleans
  -- up after a send walks `media_path`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_thumb_needs_media'
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT media_thumb_needs_media
      CHECK (media_thumb_path IS NULL OR media_path IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_thumb_path_length'
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT media_thumb_path_length
      CHECK (media_thumb_path IS NULL OR char_length(media_thumb_path) BETWEEN 1 AND 512);
  END IF;
END $$;

-- ----------------------------------------------------------- room_messages

ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS media_thumb_path text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_messages_media_thumb_needs_media'
  ) THEN
    ALTER TABLE public.room_messages
      ADD CONSTRAINT room_messages_media_thumb_needs_media
      CHECK (media_thumb_path IS NULL OR media_path IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_messages_media_thumb_path_length'
  ) THEN
    ALTER TABLE public.room_messages
      ADD CONSTRAINT room_messages_media_thumb_path_length
      CHECK (media_thumb_path IS NULL OR char_length(media_thumb_path) BETWEEN 1 AND 512);
  END IF;
END $$;

-- ------------------------------------------------- the body guard learns it

/*
  `messages_body_guard` refuses to let a tombstone be given a new body, and
  stamps `edited_at` when one changes. Both tests named `ciphertext` and
  `media_path` and nothing else, so a thumbnail path was a piece of content the
  guard did not consider content: it could be set on a deleted message, and
  repointed on a live one without the row ever reading as edited.

  Replaced rather than altered — a trigger function is replaced wholesale, and
  the rest of the body is carried over unchanged so the two copies of it (here
  and in schema.sql) stay one thing.
*/
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

  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.messages_body_guard() FROM PUBLIC, anon, authenticated;
