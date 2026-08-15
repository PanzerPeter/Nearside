/*
  Nearside — stickers

  Applied after 0032. Adds a personal sticker library: images you upload once
  and send as often as you like.

  The whole design question here was whether a sticker gets to be cheap. The
  obvious build is a public bucket and a sticker id on the message row: one
  upload, free dedup, an <img> tag and nothing to decrypt. It is also the one
  thing this schema has spent thirty-two migrations refusing to do — it would
  put "who sent which picture to whom, and when" back on the server in
  plaintext, for the one message type where the picture *is* the message. A
  server that holds no bodies but does hold "peter sent the crying-cat sticker
  to anna at 02:14" holds the conversation.

  So a sticker is not a new kind of message. Sending one is an ordinary sealed
  attachment: random per-file key, sealed bytes in `chat-media`, the key sealed
  to the recipient on the row (see 0024). The server cannot tell a sticker send
  from a photo send, and the price is that the same small file is re-uploaded
  each time. That price is paid on purpose.

  What is new is the library — the stickers you own, so they survive a reinstall
  and follow you to a new phone:

  - `stickers` rows point at objects in the `stickers` bucket, sealed under the
    owner's vault key (the same key self-chat uses). Nobody else can open them,
    which is why there is no shared read policy and no sticker sharing in this
    migration.

  - The *label* is sealed too. An unsealed keyword column would be a searchable
    index of everything in your sticker drawer, sitting in Postgres, readable
    by anyone who reaches the database — the sort of quiet metadata store the
    rest of this schema does not have.

  Bucket and its policies live in `storage/setup.sql`, like every other bucket.
*/

-- ---------------------------------------------------------------------------
-- Sending one
-- ---------------------------------------------------------------------------

/*
  `media_type` gains 'sticker'. It is a rendering hint and nothing more: a
  sticker draws without a bubble, without a caption box and at a fixed size,
  and the client cannot infer that from an image row.

  Note what this does NOT change. `media_pair` still ties the type to a path,
  the duration CHECK still refuses a duration on anything but audio, and the
  key columns are still where the file key lives. A sticker row is an
  attachment row that says how to draw itself.
*/
ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_media_type_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_type_check
  CHECK (media_type IN ('image', 'video', 'audio', 'sticker'));

-- ---------------------------------------------------------------------------
-- The library
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.stickers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Path inside the `stickers` bucket: {user_id}/{uuid}. The storage policies
  -- key off the first folder segment, so this shape is load-bearing.
  path            text NOT NULL,
  -- The per-file key, sealed under the owner's vault key. Deleting the row
  -- destroys the only copy of it; the bytes left in the bucket become
  -- unopenable rather than merely unlisted, exactly as with attachments.
  key_ciphertext  text NOT NULL,
  key_nonce       text NOT NULL,
  -- The name the owner typed, sealed the same way. See the header for why this
  -- is not a plain text column.
  label_ciphertext text NOT NULL,
  label_nonce      text NOT NULL,
  sort            integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One row per object. A second row pointing at the same bytes would make
  -- deletion ambiguous: removing one row would strand the other on an object
  -- whose key it still holds.
  CONSTRAINT stickers_path_unique UNIQUE (path)
);

CREATE INDEX IF NOT EXISTS stickers_user_idx
  ON public.stickers (user_id, sort, created_at);

ALTER TABLE public.stickers ENABLE ROW LEVEL SECURITY;

/*
  Owner-only, all four verbs, with no exception for conversation partners.

  The recipient of a sticker never reads this table — the message row carries
  its own sealed copy of the file key, so the send is self-contained. That is
  what lets the library stay completely private, and it is why revoking access
  here costs the feature nothing.
*/
DROP POLICY IF EXISTS "stickers_select_own" ON public.stickers;
CREATE POLICY "stickers_select_own" ON public.stickers
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "stickers_insert_own" ON public.stickers;
CREATE POLICY "stickers_insert_own" ON public.stickers
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

/*
  UPDATE is allowed, unlike `sealed_answers`. Renaming and reordering your own
  drawer is not a protocol step and nothing is committed against it. The USING
  and WITH CHECK are both owner-scoped so a row cannot be updated *into*
  somebody else's library.
*/
DROP POLICY IF EXISTS "stickers_update_own" ON public.stickers;
CREATE POLICY "stickers_update_own" ON public.stickers
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "stickers_delete_own" ON public.stickers;
CREATE POLICY "stickers_delete_own" ON public.stickers
  FOR DELETE TO authenticated
  USING (user_id = (select auth.uid()));

REVOKE ALL ON public.stickers FROM anon;
REVOKE ALL ON public.stickers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stickers TO authenticated;

-- PostgREST will not see a table created in the SQL editor until it reloads.
NOTIFY pgrst, 'reload schema';
