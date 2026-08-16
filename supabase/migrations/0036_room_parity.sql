/*
  Nearside — room parity

  Applied after 0035. Numbered 0036 and not 0030: the plan this implements was
  written against an older tree and 0030/0031 are taken by theme grants and
  grant hygiene.

  A room held a ciphertext, a nonce and a signature and nothing else, so a
  group could not send a photo, quote a message, react, edit, delete, or know
  it had been read. Everything below is the shape `messages` has already, with
  three differences that are not cosmetic:

    * the per-file key is sealed under the ROOM key (secretbox), not to one
      recipient (box). Every member holds the room key, so one sealed key
      serves the room; a column per member is the alternative.

    * `sig_v` exists because the signature has to start covering the media and
      reply columns. The signature is the only thing in a room that establishes
      authorship to a *client* — RLS says only the sender may UPDATE a row, but
      RLS is enforced by the server, and this app's premise is that the server
      is not trusted with content. A column outside the signature is a column
      the server can repoint on anybody's message and have the client still
      draw it as theirs.

    * `expire_messages()` has to sweep room attachments too. It collected
      doomed paths from `messages` alone, which was correct while a room row
      could not carry a file, and becomes an orphaned object per expiring room
      attachment the moment one can.

  No roles, no admins, no moderation: out of scope by decision. A Nearside room
  is a group of people who already connected to each other.
*/

-- ---------------------------------------------------------------------------
-- 1. room_messages gains what a message has
-- ---------------------------------------------------------------------------

ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS media_path           text,
  ADD COLUMN IF NOT EXISTS media_type           text,
  ADD COLUMN IF NOT EXISTS media_duration_ms    integer,
  ADD COLUMN IF NOT EXISTS media_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS media_key_nonce      text,
  ADD COLUMN IF NOT EXISTS reply_to_id          uuid REFERENCES public.room_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at            timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at           timestamptz,
  ADD COLUMN IF NOT EXISTS sig_v                smallint NOT NULL DEFAULT 1;

-- A media message with no caption has no body to seal, and inventing an empty
-- one would put a known plaintext under every attachment.
ALTER TABLE public.room_messages ALTER COLUMN ciphertext DROP NOT NULL;
ALTER TABLE public.room_messages ALTER COLUMN nonce      DROP NOT NULL;

ALTER TABLE public.room_messages
  DROP CONSTRAINT IF EXISTS room_messages_media_type_check;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_media_type_check
  CHECK (media_type IN ('image', 'video', 'audio', 'sticker'));

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_has_body;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_has_body CHECK (deleted_at IS NOT NULL
                                            OR ciphertext IS NOT NULL
                                            OR media_path IS NOT NULL);

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_sealed_pair;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_sealed_pair CHECK ((ciphertext IS NULL) = (nonce IS NULL));

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_media_pair;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_media_pair CHECK ((media_path IS NULL) = (media_type IS NULL));

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_media_key_pair;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_media_key_pair
  CHECK ((media_key_ciphertext IS NULL) = (media_key_nonce IS NULL));

-- Bound matches MAX_VOICE_MS in src/lib/audio.ts, exactly as `messages` does:
-- the client refuses to record past it and this refuses to store past it.
ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_media_duration_range;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_media_duration_range CHECK (
    media_duration_ms IS NULL
    OR (media_type = 'audio' AND media_duration_ms > 0 AND media_duration_ms <= 120000)
  );

-- Only ever 1 (pre-0036 rows) or 2 (everything written since). A row claiming
-- a version no builder exists for would verify against nothing.
ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_sig_v_known;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_sig_v_known CHECK (sig_v IN (1, 2));

CREATE INDEX IF NOT EXISTS room_messages_reply_to_idx
  ON public.room_messages (reply_to_id);

-- ---------------------------------------------------------------------------
-- 2. Editing and deleting a room message
-- ---------------------------------------------------------------------------

/*
  `edited_at` and `deleted_at` are inert without an UPDATE policy — there was
  none, because until now nothing about a room row could change.

  Sender-only, like `messages_update_sender`. The two triggers below are what
  the policy cannot express: a policy sees one row at a time and cannot compare
  the new version against the old one.
*/
DROP POLICY IF EXISTS room_messages_update_sender ON public.room_messages;
CREATE POLICY room_messages_update_sender ON public.room_messages
  FOR UPDATE TO authenticated
  USING (sender_id = (SELECT auth.uid()))
  WITH CHECK (sender_id = (SELECT auth.uid()));

/*
  Deleting a room message is a tombstone, the same as a 1:1 one: the row keeps
  its place in the thread and loses everything that was in it. Revoked as a
  privilege as well as absent as a policy, on the same reasoning `messages`
  carries — reactions and receipts cascade off these rows, and only
  `expire_messages()` removes the attachment in Storage.
*/
REVOKE DELETE ON public.room_messages FROM anon, authenticated;

/*
  `room_id` decides who may read the row, and `sender_id` is what the signature
  is checked against. A member of two rooms could otherwise move their own
  message from one to the other after the fact, in front of an audience that
  never saw it sent.

  `reply_to_id` is frozen for the reason it is frozen on `messages`: a reply
  that can be repointed later makes the quoted message something the sender
  gets to revisit, in a thread everyone else has already read.
*/
CREATE OR REPLACE FUNCTION public.room_messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id THEN
    RAISE EXCEPTION 'room_messages.room_id and room_messages.sender_id are immutable';
  END IF;
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
    RAISE EXCEPTION 'room_messages.reply_to_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_messages_prevent_reassign() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_prevent_reassign ON public.room_messages;
CREATE TRIGGER room_messages_prevent_reassign
  BEFORE UPDATE ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.room_messages_prevent_reassign();

/*
  The body, and the two timestamps the server owns. `messages_body_guard` with
  the room columns: a tombstone that can be un-deleted is not a tombstone, an
  edit that forgets to stamp `edited_at` reads to everyone else as the original
  text, and an expiry the sender can null does not expire.
*/
CREATE OR REPLACE FUNCTION public.room_messages_body_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be restored';
    END IF;
    IF NEW.ciphertext IS NOT NULL OR NEW.media_path IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be given a new body';
    END IF;
  END IF;

  IF NEW.deleted_at IS NULL
     AND (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
          OR NEW.media_path IS DISTINCT FROM OLD.media_path) THEN
    NEW.edited_at := now();
  END IF;

  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_messages_body_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_body_guard ON public.room_messages;
CREATE TRIGGER room_messages_body_guard
  BEFORE UPDATE ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.room_messages_body_guard();

-- ---------------------------------------------------------------------------
-- 3. Reactions
-- ---------------------------------------------------------------------------

/*
  The emoji is plaintext, exactly as `message_reactions` stores it. Not sealed,
  deliberately: an inconsistency between a 1:1 reaction and a room reaction is
  worse than the disclosure, and the transparency screen already declares
  reactions server-visible. It has to declare room reactions too.
*/
CREATE TABLE IF NOT EXISTS public.room_message_reactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.room_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji),
  CONSTRAINT room_emoji_length CHECK (char_length(emoji) <= 32)
);

CREATE INDEX IF NOT EXISTS room_message_reactions_message_idx
  ON public.room_message_reactions (message_id);
CREATE INDEX IF NOT EXISTS room_message_reactions_user_time
  ON public.room_message_reactions (user_id, created_at);

ALTER TABLE public.room_message_reactions ENABLE ROW LEVEL SECURITY;

-- Membership of the room the message is in, reached through the message.
-- `is_room_member` is SECURITY DEFINER for the recursion reason in section 7
-- of schema.sql, and using it here keeps this policy one lookup deep.
DROP POLICY IF EXISTS room_reactions_select_member ON public.room_message_reactions;
CREATE POLICY room_reactions_select_member ON public.room_message_reactions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.room_messages m
     WHERE m.id = message_id AND public.is_room_member(m.room_id)
  ));

DROP POLICY IF EXISTS room_reactions_insert_own ON public.room_message_reactions;
CREATE POLICY room_reactions_insert_own ON public.room_message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.room_messages m
       WHERE m.id = message_id AND public.is_room_member(m.room_id)
    )
  );

DROP POLICY IF EXISTS room_reactions_delete_own ON public.room_message_reactions;
CREATE POLICY room_reactions_delete_own ON public.room_message_reactions
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.room_message_reactions FROM anon;
REVOKE ALL ON public.room_message_reactions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.room_message_reactions TO authenticated;

-- The runaway guard `message_reactions` has. The UNIQUE above bounds repeats
-- of one emoji but not a loop cycling through different ones.
CREATE OR REPLACE FUNCTION public.enforce_room_reaction_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.room_message_reactions r
  WHERE r.user_id = NEW.user_id
    AND r.created_at > now() - interval '1 minute';

  IF recent >= 60 THEN
    RAISE EXCEPTION 'rate_limited_reactions';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_room_reaction_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_message_reactions_rate_limit ON public.room_message_reactions;
CREATE TRIGGER room_message_reactions_rate_limit
  BEFORE INSERT ON public.room_message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_room_reaction_rate();

-- ---------------------------------------------------------------------------
-- 4. Read receipts
-- ---------------------------------------------------------------------------

/*
  One high-water mark per member per room, not a row per message per member:
  a 60-person room reading 200 messages is 12,000 rows of the same fact.

  SELECT is every member, because "read by 4" is drawn from other people's
  marks. INSERT and UPDATE stay owner-only, so nobody can forge a claim that
  you read something. Clients must only ever write a timestamp they read off a
  message row — `created_at` is stamped by the server clock, and a device with
  a fast clock would otherwise mark unread messages read.
*/
CREATE TABLE IF NOT EXISTS public.room_receipts (
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE public.room_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS room_receipts_select_member ON public.room_receipts;
CREATE POLICY room_receipts_select_member ON public.room_receipts
  FOR SELECT TO authenticated
  USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS room_receipts_insert_own ON public.room_receipts;
CREATE POLICY room_receipts_insert_own ON public.room_receipts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND public.is_room_member(room_id));

DROP POLICY IF EXISTS room_receipts_update_own ON public.room_receipts;
CREATE POLICY room_receipts_update_own ON public.room_receipts
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.room_receipts FROM anon;
REVOKE ALL ON public.room_receipts FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.room_receipts TO authenticated;

-- Clamped like `receipts_monotonic`: a realtime handler and a focus handler
-- can write in either order, and an offline device flushes stale values on
-- reconnect. A read mark that can move backwards is one a client bug un-reads.
CREATE OR REPLACE FUNCTION public.room_receipts_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.read_at < OLD.read_at THEN
    NEW.read_at := OLD.read_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_receipts_monotonic() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_receipts_monotonic ON public.room_receipts;
CREATE TRIGGER room_receipts_monotonic
  BEFORE UPDATE ON public.room_receipts
  FOR EACH ROW EXECUTE FUNCTION public.room_receipts_monotonic();

-- ---------------------------------------------------------------------------
-- 5. Room picture
-- ---------------------------------------------------------------------------

-- An attachment that happens to be an avatar: an object in `chat-media` and a
-- file key sealed under the room key. Profile avatars are plaintext; a group
-- photo names the group to the server, and sealing it costs one reuse of
-- lib/media-crypto.ts.
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS avatar_path           text,
  ADD COLUMN IF NOT EXISTS avatar_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS avatar_key_nonce      text;

-- All three or none of them. A path whose key is missing is an image that can
-- never be opened, and it would be drawn as a broken picture forever.
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_avatar_complete;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_avatar_complete
  CHECK (num_nonnulls(avatar_path, avatar_key_ciphertext, avatar_key_nonce) IN (0, 3));

/*
  Written through an RPC, and `rooms` still has no UPDATE policy.

  This is `set_room_timer` again, for the same reason it is a definer function
  and not a policy: an UPDATE policy on `rooms` can say who may write the row
  but not which columns they wrote, so "a member may set the picture" would
  also read as "a member may rename the room, hand it to themselves by
  rewriting created_by, or clear the disappearing timer everyone agreed on".
  Naming the three columns in the function body is the whole guard.

  Any member, not just the creator — a room has no roles by decision, and the
  timer is already changeable by anyone in it.
*/
CREATE OR REPLACE FUNCTION public.set_room_avatar(
  target       uuid,
  path         text,
  key_ct       text,
  key_nonce    text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  -- Clearing the picture means all three go, together. Half a pointer is a
  -- path whose key nobody holds, which renders as a permanently broken image.
  IF (path IS NULL) <> (key_ct IS NULL) OR (key_ct IS NULL) <> (key_nonce IS NULL) THEN
    RAISE EXCEPTION 'a room picture needs a path and both key halves, or none';
  END IF;

  UPDATE public.rooms
     SET avatar_path           = path,
         avatar_key_ciphertext = key_ct,
         avatar_key_nonce      = key_nonce
   WHERE id = target;
END;
$$;

REVOKE ALL ON FUNCTION public.set_room_avatar(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_avatar(uuid, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5b. Where room attachments live
-- ---------------------------------------------------------------------------

/*
  `chat-media`, under `{roomId}/{uuid.ext}` — one folder per room rather than
  the `{uidA}_{uidB}` folder a conversation uses, because membership of a room
  is not a pair. A room id is a bare uuid and a conversation folder always
  contains an underscore, so the two shapes cannot be confused.

  Word-for-word the same policies as the guarded block in storage/setup.sql,
  which cannot install them itself on this path: it runs immediately after
  0001, and `is_room_member()` does not exist until 0026. `npm run db:verify`
  builds a database each way and diffs the storage policies, so the two copies
  cannot drift without failing.

  The CASE is what keeps this policy from raising on somebody else's upload:
  `::uuid` on a conversation folder would error, and an error inside any
  permissive policy fails the whole statement rather than just declining this
  one. CASE is the only construct with a guaranteed evaluation order.

  No DELETE policy, deliberately: attachments are removed by
  `expire_messages()`, which runs as the owner. A member who could delete
  objects directly could clear the room's history for everyone.
*/
DROP POLICY IF EXISTS "chat_media_read_room_member" ON storage.objects;
CREATE POLICY "chat_media_read_room_member" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND CASE
          WHEN (storage.foldername(name))[1] ~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN public.is_room_member(((storage.foldername(name))[1])::uuid)
          ELSE false
        END
  );

DROP POLICY IF EXISTS "chat_media_insert_room_member" ON storage.objects;
CREATE POLICY "chat_media_insert_room_member" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND CASE
          WHEN (storage.foldername(name))[1] ~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN public.is_room_member(((storage.foldername(name))[1])::uuid)
          ELSE false
        END
  );

-- ---------------------------------------------------------------------------
-- 6. The expiry sweep has to reach room attachments
-- ---------------------------------------------------------------------------

/*
  It deleted expired rows from both tables already, but collected the doomed
  object paths from `messages` alone — correct while a room row could not carry
  a file, and one orphaned object per expiring room attachment from now on. The
  bytes are unopenable either way (the row held the only copy of the key); this
  reclaims the listing and the storage quota.
*/
CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed text[];
BEGIN
  SELECT coalesce(array_agg(media_path), '{}')
    INTO doomed
    FROM (
      SELECT media_path FROM public.messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
      UNION ALL
      SELECT media_path FROM public.room_messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
    ) expiring;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Best effort. The rows above held the only copies of these files' keys, so
  -- the bytes are already unopenable; this reclaims the listing.
  IF array_length(doomed, 1) > 0 THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Realtime
-- ---------------------------------------------------------------------------

-- FULL so a DELETE carries the old row: removing a reaction has to reach the
-- other members, and realtime evaluates the SELECT policy against the record
-- in the event. Same reason `message_reactions` carries it.
ALTER TABLE public.room_message_reactions REPLICA IDENTITY FULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['room_message_reactions', 'room_receipts'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
