/*
  ===========================================================================
  Nearside — the whole schema, as it stands
  ===========================================================================

  What this file is:
    Everything `migrations/` adds up to, in one readable pass. Run it once on
    a fresh Supabase project and you get the database this app talks to, with
    no dead columns and nothing to replay in the right order. It is the answer
    to "what does the server actually hold?" — the question the migration
    folder can only answer by being read end to end.

  What this file is NOT:
    A migration. It creates the current shape directly and knows nothing about
    the shapes that came before, so it must never be run against a database
    that already has data. `migrations/` is the only safe path for the live
    project, and remains the record of what was applied to it.

  It cannot drift:
    `npm run db:verify` builds one database by replaying every migration in
    `migrations/apply-order.txt` and another from this file, then compares the
    two catalogs — tables, columns, constraints, indexes, policies, function
    bodies, triggers, grants, realtime membership and bucket configuration.
    Editing one without the other fails.

  Storage lives in `storage/setup.sql` and is not repeated here. Buckets and
  their policies are the one part of this schema that a second copy would be
  free to contradict, so there is only ever one.

  Reading order below follows the app: who you are, who you are connected to,
  what you send, where it is kept, and what the server is allowed to compute
  over it. Section 0 is the summary of what all of it amounts to.

  ---------------------------------------------------------------------------
  0. The point of the design

  The server stores no message body. `messages` and `room_messages` hold a
  ciphertext, a nonce and metadata; there is no column a plaintext could
  arrive in and no function that reads one. Conversation previews and search
  run against a per-device SQLite mirror (`src/lib/localdb.ts`), which is why
  `conversation_list()` returns a timestamp and a sender and no text.

  Attachments are sealed with a random per-file key before upload. The key
  travels sealed on the message row (`media_key_ciphertext`), so deleting the
  row destroys the only copy of it and the bytes left in Storage become
  unopenable rather than merely unlisted.

  Every table has RLS on. Several tables also have privileges revoked, which
  is a separate gate and deliberately so: `theme_grants` is protected by a
  missing INSERT privilege as much as by a missing policy, because a policy
  added carelessly later should not be enough to open the till.
  ---------------------------------------------------------------------------
*/

-- ===========================================================================
-- 1. Extensions
-- ===========================================================================

-- pg_trgm backed the trigram index on messages.content. Both the index and
-- the column are gone (0023 — the server stopped reading bodies), and the
-- extension is kept only because it is installed on the live project and this
-- file describes that project. Nothing here uses it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pg_net issues the push trigger's HTTP call off the inserting transaction.
-- It creates and owns the `net` schema, so there is no WITH SCHEMA clause.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ===========================================================================
-- 2. Shared helper
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- A trigger function is fired by the executor and never called by name, but
-- PostgREST exposes every executable function in `public` at
-- /rest/v1/rpc/<name>. Revoked for surface reduction, not because a call
-- would succeed — Postgres refuses to run a trigger function outside a
-- trigger context.
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 3. Identity
-- ===========================================================================

/*
  One row per account, created by the signup trigger.

  `display_name` is not unique and has no format constraint. A unique handle
  is a namespace and a namespace is enumerable; display names are allowed to
  collide, and that is what stops them being addresses. People are found by
  connect code (section 4), never by name.

  `public_key` / `signing_key` are the PUBLIC halves of the device identity —
  X25519 for sealing to this user, Ed25519 for verifying room messages from
  them. The seed they derive from never reaches this database and there is no
  column here for it to arrive in. They are nullable because an account can
  exist before its device has finished generating one.

  `key_updated_at` makes a key change observable. A rotated key is a security
  event rather than an edit, and this is what lets a peer notice and force
  re-verification.
*/
CREATE TABLE IF NOT EXISTS public.profiles (
  id             uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name   text NOT NULL,
  avatar_url     text,
  last_seen_at   timestamptz,
  public_key     text,
  signing_key    text,
  key_updated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Declared here, out of section order, because the profiles SELECT policy
-- below reads it and a policy cannot name a table that does not exist yet.
-- Its indexes, policies and rate limit are in section 4 with the rest of it.
CREATE TABLE IF NOT EXISTS public.friendships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id),
  CONSTRAINT no_self_friend CHECK (requester_id <> addressee_id)
);

/*
  There is no directory. SELECT reaches yourself and anyone you have a
  friendship row with in either direction — including a pending one, so a
  request can show who sent it. A window with no SELECT policy fails closed,
  which is the correct direction to fail.

  The single UPDATE policy covers the key columns too: RLS is per row, not per
  column. A second permissive UPDATE policy would be OR'd with this one and
  grant nothing, while adding a second place a future narrowing has to be
  remembered.
*/
DROP POLICY IF EXISTS "profiles_select_connected" ON public.profiles;
CREATE POLICY "profiles_select_connected" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE (f.requester_id = (select auth.uid()) AND f.addressee_id = profiles.id)
         OR (f.addressee_id = (select auth.uid()) AND f.requester_id = profiles.id)
    )
  );

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE TO authenticated USING ((select auth.uid()) = id);

/*
  Signup. Open since 0019 — the invite gate was right for a private chat among
  friends and wrong for a store listing.

  No lower(): a display name is shown as the person typed it. The metadata key
  `username` is still read as a fallback so a client mid-upgrade signs up
  successfully.

  SECURITY DEFINER because it writes public.profiles from a trigger on
  auth.users, and REVOKEd from every client role.
*/
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    coalesce(
      NEW.raw_user_meta_data->>'display_name',
      NEW.raw_user_meta_data->>'username'
    )
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ===========================================================================
-- 4. Connections
-- ===========================================================================

-- The table itself is in section 3 — see the note there.

-- Covering index for the addressee_id FK (pending-requests lookup).
CREATE INDEX IF NOT EXISTS friendships_addressee_idx
  ON public.friendships (addressee_id);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friendships_select_own" ON public.friendships;
CREATE POLICY "friendships_select_own" ON public.friendships
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (requester_id, addressee_id));

DROP POLICY IF EXISTS "friendships_insert_own" ON public.friendships;
CREATE POLICY "friendships_insert_own" ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = requester_id);

DROP POLICY IF EXISTS "friendships_update_addressee" ON public.friendships;
CREATE POLICY "friendships_update_addressee" ON public.friendships
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = addressee_id)
  WITH CHECK ((select auth.uid()) = addressee_id);

DROP POLICY IF EXISTS "friendships_delete_own" ON public.friendships;
CREATE POLICY "friendships_delete_own" ON public.friendships
  FOR DELETE TO authenticated
  USING ((select auth.uid()) IN (requester_id, addressee_id));

/*
  A runaway guard, not an anti-abuse perimeter. A looping client or a buggy
  retry must not be able to fill the table. Twenty outbound requests an hour
  is far above anything a person does by hand.
*/
CREATE OR REPLACE FUNCTION public.enforce_friendship_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.friendships f
  WHERE f.requester_id = NEW.requester_id
    AND f.created_at > now() - interval '1 hour';

  IF recent >= 20 THEN
    RAISE EXCEPTION 'rate_limited_requests';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_friendship_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS friendships_rate_limit ON public.friendships;
CREATE TRIGGER friendships_rate_limit
  BEFORE INSERT ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_friendship_rate();

/*
  Connect codes — how two people find each other now that there is no
  directory. Short-lived, single-use, and reachable only through the two
  functions below.

  No RLS policy at all, on purpose: a client that could read this table could
  enumerate live codes. RLS with no policy fails closed, and the definer
  functions run as the owner, so they are unaffected.
*/
CREATE TABLE IF NOT EXISTS public.connect_tokens (
  code       text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.connect_tokens ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mint_connect_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Crockford-style: no O, no I, no L, no U, no 0/1. These codes are read
  -- aloud down a phone line and typed by hand, so the alphabet is chosen for
  -- the ear and the thumb, not for density. 30^8 is ~6.5e11 -- ample for a
  -- token that dies in ten minutes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  new_code text;
  raw      bytea;
  attempt  int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  DELETE FROM public.connect_tokens WHERE user_id = auth.uid() AND used_at IS NULL;

  -- Retry on the astronomically unlikely primary-key collision rather than
  -- letting it surface as a raw 23505 to someone trying to add a friend.
  LOOP
    -- gen_random_bytes, not random(): random() is a session-seeded PRNG, and a
    -- predictable connect code is an invitation an attacker can redeem before
    -- its owner does. The modulo bias across 30 symbols is a fraction of a bit
    -- and irrelevant for a single-use token with a ten-minute life.
    -- Schema-qualified: pgcrypto is installed in `extensions` on this project,
    -- and SET search_path = '' means an unqualified call does not resolve.
    raw := extensions.gen_random_bytes(8);
    new_code := '';
    FOR i IN 0..7 LOOP
      new_code := new_code || substr(alphabet, 1 + (get_byte(raw, i) % length(alphabet)), 1);
    END LOOP;

    BEGIN
      INSERT INTO public.connect_tokens (code, user_id, expires_at)
      VALUES (new_code, auth.uid(), now() + interval '10 minutes');
      RETURN new_code;
    EXCEPTION WHEN unique_violation THEN
      attempt := attempt + 1;
      IF attempt >= 5 THEN RAISE EXCEPTION 'code_mint_failed'; END IF;
    END;
  END LOOP;
END;
$$;

-- Marks the token spent and returns its owner in one statement, so two people
-- cannot redeem the same code.
CREATE OR REPLACE FUNCTION public.redeem_connect_code(code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  UPDATE public.connect_tokens t
     SET used_at = now(), used_by = auth.uid()
   WHERE t.code = upper(redeem_connect_code.code)
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND t.user_id <> auth.uid()
  RETURNING t.user_id INTO owner;

  IF owner IS NULL THEN RAISE EXCEPTION 'code_invalid'; END IF;
  RETURN owner;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_connect_code() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_connect_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mint_connect_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_connect_code(text) TO authenticated;

-- ===========================================================================
-- 5. Messages
-- ===========================================================================

/*
  One row per 1:1 message. There is no `content` column and no way to add one
  without this file saying so.

  `ciphertext` / `nonce` — a secretbox (self-chat, under the device's vault
  key) or a box (to the peer's published public_key). Opaque to the database
  and to anyone holding a database credential. The authentication tag is
  inside the ciphertext, so a row edited in the database fails to open on the
  device rather than decrypting to something chosen by whoever edited it.

  `media_key_ciphertext` / `media_key_nonce` — the attachment's per-file key,
  sealed to the recipient. Sealing a 32-byte key is cheap; sealing a 50 MB
  video per recipient is not, which is why the file itself gets one random key
  and a secretbox.

  `forwarded` is a flag and deliberately not a pointer. A `forwarded_from_id`
  would name a message in a conversation the new recipient is not part of, and
  a `forwarded_from_user` would tell them who the sender was talking to — a
  disclosure neither of those people agreed to.

  `expires_at` is stamped by trigger from the conversation's timer and never
  trusted from the client (section 8).

  The self-chat is an ordinary row with `user_id = receiver_id`. No friendship
  backs it — `no_self_friend` forbids one — so the self case is named
  explicitly in each policy that gates on it, rather than by inventing a
  friendship row that every "people you can talk to" query would then have to
  exclude.
*/
CREATE TABLE IF NOT EXISTS public.messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reply_to_id          uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  ciphertext           text,
  nonce                text,
  media_path           text,
  media_type           text,
  media_duration_ms    integer,
  media_key_ciphertext text,
  media_key_nonce      text,
  forwarded            boolean NOT NULL DEFAULT false,
  edited_at            timestamptz,
  deleted_at           timestamptz,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_media_type_check CHECK (media_type IN ('image', 'video', 'audio')),

  -- A row must carry something. Tombstones are exempt and must be:
  -- deleteMessage strips the body, the ciphertext and the media path, and
  -- having nothing left is the entire point of a deletion.
  CONSTRAINT has_body CHECK (deleted_at IS NOT NULL
                          OR ciphertext IS NOT NULL
                          OR media_path IS NOT NULL),

  -- Half of a sealed pair is unopenable — a state no code path intends and
  -- every reader would otherwise have to defend against.
  CONSTRAINT sealed_pair    CHECK ((ciphertext IS NULL) = (nonce IS NULL)),
  CONSTRAINT media_pair     CHECK ((media_path IS NULL) = (media_type IS NULL)),
  CONSTRAINT media_key_pair CHECK ((media_key_ciphertext IS NULL) = (media_key_nonce IS NULL)),

  -- Only a voice note carries a duration, and only one inside the recording
  -- cap. Bound matches MAX_VOICE_MS in src/lib/audio.ts: the client refuses to
  -- record past it, and this refuses to store past it.
  CONSTRAINT media_duration_range CHECK (
    media_duration_ms IS NULL
    OR (media_type = 'audio' AND media_duration_ms > 0 AND media_duration_ms <= 120000)
  )
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages (user_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_rev_idx
  ON public.messages (receiver_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON public.messages (reply_to_id);

-- Partial: the overwhelming majority of rows never expire, and a full index on
-- a mostly-null column costs writes to answer a question about a minority.
CREATE INDEX IF NOT EXISTS messages_expiring
  ON public.messages (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select_participant" ON public.messages;
CREATE POLICY "messages_select_participant" ON public.messages
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_id, receiver_id));

-- The self branch widens *who you may address* by exactly one person —
-- yourself — and cannot reach anyone else: `receiver_id = user_id` and
-- `user_id = auth.uid()` together leave one possible receiver.
DROP POLICY IF EXISTS "messages_insert_sender" ON public.messages;
CREATE POLICY "messages_insert_sender" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND receiver_id IS NOT NULL
    AND (
      -- The self-chat. No friendship exists or can exist for this pair.
      receiver_id = user_id
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND (
            (f.requester_id = (select auth.uid()) AND f.addressee_id = receiver_id)
            OR (f.requester_id = receiver_id AND f.addressee_id = (select auth.uid()))
          )
      )
    )
  );

DROP POLICY IF EXISTS "messages_update_sender" ON public.messages;
CREATE POLICY "messages_update_sender" ON public.messages
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "messages_delete_sender" ON public.messages;
CREATE POLICY "messages_delete_sender" ON public.messages
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

/*
  An RLS policy cannot compare the NEW row against the OLD one, so the UPDATE
  policy above can only check who is writing — not what they are changing.
  Without this trigger a sender could edit an existing message and repoint
  `receiver_id` at an arbitrary user, delivering an unsolicited DM that
  bypasses the friendship gate entirely. It is also what keeps a self-note from
  later being repointed at a stranger.

  `forwarded` is frozen alongside them: provenance that can be edited
  afterwards is not provenance.
*/
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
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.messages_prevent_reassign() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_prevent_reassign ON public.messages;
CREATE TRIGGER messages_prevent_reassign
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_prevent_reassign();

-- Sixty a minute is far above human speed; a person typing fast sends perhaps
-- twenty. This stops a loop, not a spammer.
CREATE OR REPLACE FUNCTION public.enforce_message_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.messages m
  WHERE m.user_id = NEW.user_id
    AND m.created_at > now() - interval '1 minute';

  IF recent >= 60 THEN
    RAISE EXCEPTION 'rate_limited_messages';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_message_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_rate_limit ON public.messages;
CREATE TRIGGER messages_rate_limit
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_rate();

-- ---------------------------------------------------------------------------
-- 5a. Reactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.message_reactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji),
  CONSTRAINT emoji_length CHECK (char_length(emoji) <= 32)
);

CREATE INDEX IF NOT EXISTS message_reactions_message_idx
  ON public.message_reactions (message_id);

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reactions_select_participant" ON public.message_reactions;
CREATE POLICY "reactions_select_participant" ON public.message_reactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND (select auth.uid()) IN (m.user_id, m.receiver_id)
    )
  );

DROP POLICY IF EXISTS "reactions_insert_own" ON public.message_reactions;
CREATE POLICY "reactions_insert_own" ON public.message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND (select auth.uid()) IN (m.user_id, m.receiver_id)
    )
  );

DROP POLICY IF EXISTS "reactions_delete_own" ON public.message_reactions;
CREATE POLICY "reactions_delete_own" ON public.message_reactions
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 5b. Delivery and read receipts
-- ---------------------------------------------------------------------------

/*
  Two monotonic watermarks per direction. A row is owned by `user_id` — the
  person RECEIVING from `peer_id`. `delivered_at` means every message peer_id
  sent me at or before this instant reached one of my devices; `read_at` means
  I looked at them. Both are compared against messages.created_at, which is
  stamped by the server clock, so clients must only ever write timestamps they
  read off a message row — never their own Date.now().

  SELECT is deliberately wider than the owner: the peer has to read my
  watermarks to draw ticks on their own sent messages. That exposes two
  timestamps about someone you already chat with. INSERT and UPDATE stay
  owner-only, so nobody can forge a receipt claiming you read something.
*/
CREATE TABLE IF NOT EXISTS public.message_receipts (
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delivered_at timestamptz,
  read_at      timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, peer_id),
  CONSTRAINT no_self_receipt CHECK (user_id <> peer_id)
);

-- The sender's tick lookup goes the other way round from the primary key.
CREATE INDEX IF NOT EXISTS message_receipts_peer_idx
  ON public.message_receipts (peer_id, user_id);

ALTER TABLE public.message_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "receipts_select_participant" ON public.message_receipts;
CREATE POLICY "receipts_select_participant" ON public.message_receipts
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_id, peer_id));

DROP POLICY IF EXISTS "receipts_insert_own" ON public.message_receipts;
CREATE POLICY "receipts_insert_own" ON public.message_receipts
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipts_update_own" ON public.message_receipts;
CREATE POLICY "receipts_update_own" ON public.message_receipts
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipts_delete_own" ON public.message_receipts;
CREATE POLICY "receipts_delete_own" ON public.message_receipts
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

/*
  Clients race: a realtime handler and a focus handler can write in either
  order, and an offline device flushes stale values on reconnect. Clamping here
  means no client can un-read or un-deliver a message, so the UI never shows a
  tick going backwards.
*/
CREATE OR REPLACE FUNCTION public.receipts_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.delivered_at IS NOT NULL
       AND (NEW.delivered_at IS NULL OR NEW.delivered_at < OLD.delivered_at) THEN
      NEW.delivered_at := OLD.delivered_at;
    END IF;
    IF OLD.read_at IS NOT NULL
       AND (NEW.read_at IS NULL OR NEW.read_at < OLD.read_at) THEN
      NEW.read_at := OLD.read_at;
    END IF;
  END IF;

  -- Reading something implies it reached you, so delivered can never trail
  -- read. Without this a client that only ever advances read_at would leave
  -- delivered_at null and the sender would show a single tick on a read message.
  IF NEW.read_at IS NOT NULL
     AND (NEW.delivered_at IS NULL OR NEW.delivered_at < NEW.read_at) THEN
    NEW.delivered_at := NEW.read_at;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.receipts_monotonic() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS message_receipts_monotonic ON public.message_receipts;
CREATE TRIGGER message_receipts_monotonic
  BEFORE INSERT OR UPDATE ON public.message_receipts
  FOR EACH ROW EXECUTE FUNCTION public.receipts_monotonic();

-- ===========================================================================
-- 6. Private per-user settings
-- ===========================================================================

/*
  Both tables below follow the same shape: one row per (owner, peer), owner-only
  in every direction, writes gated on an accepted friendship or the self-chat,
  clearing deliberately NOT gated — after a defriend you must still be able to
  drop your own row.

  Privileges are granted explicitly here rather than relying on Supabase's
  historical default of auto-granting every new public table to the client
  roles. That default is moving to opt-in, and a table created today can end up
  reachable by no client role at all — which surfaces as 42501 "permission
  denied", not as an RLS denial.
*/

CREATE TABLE IF NOT EXISTS public.chat_backgrounds (
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  media_path text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, peer_id),
  CONSTRAINT media_path_length CHECK (char_length(media_path) BETWEEN 1 AND 512)
);

-- The PK indexes (owner_id, peer_id); peer_id needs its own for the FK.
CREATE INDEX IF NOT EXISTS chat_backgrounds_peer_idx
  ON public.chat_backgrounds (peer_id);

ALTER TABLE public.chat_backgrounds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.chat_backgrounds FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_backgrounds TO authenticated;

DROP TRIGGER IF EXISTS chat_backgrounds_set_updated_at ON public.chat_backgrounds;
CREATE TRIGGER chat_backgrounds_set_updated_at
  BEFORE UPDATE ON public.chat_backgrounds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP POLICY IF EXISTS "chat_backgrounds_select_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_select_own" ON public.chat_backgrounds
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "chat_backgrounds_insert_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_insert_own" ON public.chat_backgrounds
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND (
      peer_id = owner_id
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
            OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
      )
    )
  );

-- Replacing a background is an upsert, so the same gate has to hold on UPDATE.
DROP POLICY IF EXISTS "chat_backgrounds_update_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_update_own" ON public.chat_backgrounds
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id)
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND (
      peer_id = owner_id
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
            OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
      )
    )
  );

DROP POLICY IF EXISTS "chat_backgrounds_delete_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_delete_own" ON public.chat_backgrounds
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

/*
  A name you give someone, visible only to you. The shared-nickname model —
  both participants see and can change one label — was deliberately not chosen:
  it lets one person relabel the other, which is a harassment vector in a
  two-person app with no moderation.

  Self-nicknames are allowed on purpose (no owner <> peer CHECK): the self-chat
  is addressed as peer_id = owner_id, so this is what lets someone rename
  "Note to self" without a second mechanism.
*/
CREATE TABLE IF NOT EXISTS public.friend_nicknames (
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nickname   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, peer_id),
  -- Measured after trimming, so " " cannot pass as a one-character nickname
  -- and leave a row that renders as a blank name.
  CONSTRAINT nickname_length CHECK (char_length(btrim(nickname)) BETWEEN 1 AND 32),
  -- Displayed inline in the sidebar and the chat header, so a newline or other
  -- control character would break that line. Rejected at the column rather
  -- than trusted to be stripped by whichever client wrote it.
  CONSTRAINT nickname_single_line CHECK (nickname ~ '^[^[:cntrl:]]+$')
);

CREATE INDEX IF NOT EXISTS friend_nicknames_peer_idx
  ON public.friend_nicknames (peer_id);

ALTER TABLE public.friend_nicknames ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.friend_nicknames FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friend_nicknames TO authenticated;

DROP TRIGGER IF EXISTS friend_nicknames_set_updated_at ON public.friend_nicknames;
CREATE TRIGGER friend_nicknames_set_updated_at
  BEFORE UPDATE ON public.friend_nicknames
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP POLICY IF EXISTS "friend_nicknames_select_own" ON public.friend_nicknames;
CREATE POLICY "friend_nicknames_select_own" ON public.friend_nicknames
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "friend_nicknames_insert_own" ON public.friend_nicknames;
CREATE POLICY "friend_nicknames_insert_own" ON public.friend_nicknames
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND (
      peer_id = owner_id
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
            OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
      )
    )
  );

DROP POLICY IF EXISTS "friend_nicknames_update_own" ON public.friend_nicknames;
CREATE POLICY "friend_nicknames_update_own" ON public.friend_nicknames
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id)
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND (
      peer_id = owner_id
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
            OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
      )
    )
  );

DROP POLICY IF EXISTS "friend_nicknames_delete_own" ON public.friend_nicknames;
CREATE POLICY "friend_nicknames_delete_own" ON public.friend_nicknames
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

-- ===========================================================================
-- 7. Rooms
-- ===========================================================================

/*
  One symmetric key encrypts a room. Each member gets their own copy of it
  sealed to their published public key, so the server distributes a key it
  cannot open, and adding a member is one row rather than re-encrypting the
  history.

  `room_messages.signature` is what makes authorship cryptographic. secretbox
  gives confidentiality, not authorship: every member holds the room key, so
  any of them could write a message and `sender_id` would happily attest to
  whoever they claimed to be. The client verifies the Ed25519 signature over
  the ciphertext BEFORE decrypting.

  Removing a member deletes their participant row and their sealed key. They
  keep whatever they already downloaded, which is unavoidable and which the UI
  says at removal time. Rotating the key for future messages is the client's
  job — only a member can generate one.
*/
CREATE TABLE IF NOT EXISTS public.rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  created_by  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ttl_seconds integer,
  ttl_set_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 60),
  CONSTRAINT rooms_ttl_positive CHECK (ttl_seconds IS NULL OR ttl_seconds > 0)
);

CREATE TABLE IF NOT EXISTS public.room_participants (
  room_id      uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  colour_index smallint NOT NULL DEFAULT 0,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_participants_user ON public.room_participants (user_id);

CREATE TABLE IF NOT EXISTS public.room_keys (
  room_id        uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_ciphertext text NOT NULL,
  key_nonce      text NOT NULL,
  sealed_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, user_id)
);

-- `id` is client-generated, like messages: a retry after a lost response
-- collides on the primary key instead of duplicating the message.
CREATE TABLE IF NOT EXISTS public.room_messages (
  id         uuid PRIMARY KEY,
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  nonce      text NOT NULL,
  signature  text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_messages_room_time
  ON public.room_messages (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS room_messages_expiring
  ON public.room_messages (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE public.rooms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_messages     ENABLE ROW LEVEL SECURITY;

/*
  SECURITY DEFINER because the obvious policy — "you may read a room if a row
  in room_participants says so" — recurses: reading room_participants is itself
  gated on membership. A definer function reads the membership table with RLS
  off and returns a boolean, which leaks nothing beyond the answer the policy
  was about to act on anyway.
*/
CREATE OR REPLACE FUNCTION public.is_room_member(target uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_participants p
     WHERE p.room_id = target AND p.user_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.is_room_owner(target uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
     WHERE r.id = target AND r.created_by = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_room_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_room_owner(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_room_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_owner(uuid)  TO authenticated;

DROP POLICY IF EXISTS rooms_select_member ON public.rooms;
CREATE POLICY rooms_select_member ON public.rooms
  FOR SELECT TO authenticated USING (public.is_room_member(id));

DROP POLICY IF EXISTS rooms_insert_own ON public.rooms;
CREATE POLICY rooms_insert_own ON public.rooms
  FOR INSERT TO authenticated WITH CHECK (created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS rooms_delete_creator ON public.rooms;
CREATE POLICY rooms_delete_creator ON public.rooms
  FOR DELETE TO authenticated USING (created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS participants_select_member ON public.room_participants;
CREATE POLICY participants_select_member ON public.room_participants
  FOR SELECT TO authenticated USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS participants_insert_creator ON public.room_participants;
CREATE POLICY participants_insert_creator ON public.room_participants
  FOR INSERT TO authenticated WITH CHECK (public.is_room_owner(room_id));

-- The creator removes members; anyone may remove themselves. Leaving is not a
-- privilege the room owner should be able to withhold.
DROP POLICY IF EXISTS participants_delete_owner_or_self ON public.room_participants;
CREATE POLICY participants_delete_owner_or_self ON public.room_participants
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_room_owner(room_id));

-- A member may read only their OWN sealed copy. Someone else's would be
-- useless (it is sealed to their key) but there is no reason to hand it over.
DROP POLICY IF EXISTS keys_select_own ON public.room_keys;
CREATE POLICY keys_select_own ON public.room_keys
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- Sealing is the room owner's job, and `sealed_by` must be the account doing
-- it: without the ownership half, any authenticated user could write a key row
-- into any room and hand a member a key of the attacker's choosing.
DROP POLICY IF EXISTS keys_insert_sealer ON public.room_keys;
CREATE POLICY keys_insert_sealer ON public.room_keys
  FOR INSERT TO authenticated
  WITH CHECK (sealed_by = (SELECT auth.uid()) AND public.is_room_owner(room_id));

DROP POLICY IF EXISTS keys_delete_owner ON public.room_keys;
CREATE POLICY keys_delete_owner ON public.room_keys
  FOR DELETE TO authenticated USING (public.is_room_owner(room_id));

DROP POLICY IF EXISTS room_messages_select_member ON public.room_messages;
CREATE POLICY room_messages_select_member ON public.room_messages
  FOR SELECT TO authenticated USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS room_messages_insert_member ON public.room_messages;
CREATE POLICY room_messages_insert_member ON public.room_messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND public.is_room_member(room_id));

-- ===========================================================================
-- 8. Disappearing messages
-- ===========================================================================

/*
  The row is deleted rather than flagged. A tombstone is a row that still
  exists, and the app's transparency screen lists every row keyed to the user —
  so a flagged-but-present message would have to appear there, and it would be
  right to. Deleting is the only version of this feature that survives the
  app's own claims about itself.

  The pair is normalized with least/greatest so there is exactly one row per
  conversation regardless of who sets it, and the two sides cannot end up
  holding different timers. `normalizePair()` in src/lib/disappearing.ts and
  the `timers_normalized` CHECK below must not drift.

  An attachment's per-file key lives only on the message row, so deleting the
  row destroys the key and the ciphertext left in Storage is unopenable by
  anyone, including the server.
*/
CREATE TABLE IF NOT EXISTS public.conversation_timers (
  user_a      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ttl_seconds integer,
  set_by      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  -- <= rather than <: the self-chat (user_a = user_b) is a conversation like
  -- any other and gets a timer like any other.
  CONSTRAINT timers_normalized CHECK (user_a <= user_b),
  CONSTRAINT timers_positive CHECK (ttl_seconds IS NULL OR ttl_seconds > 0)
);

ALTER TABLE public.conversation_timers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timers_select_participant ON public.conversation_timers;
CREATE POLICY timers_select_participant ON public.conversation_timers
  FOR SELECT TO authenticated
  USING (auth.uid() IN (user_a, user_b));

-- No INSERT or UPDATE policy: writes go through set_conversation_timer(),
-- which is the only thing that can normalize the pair correctly and record
-- who changed it.

/*
  A timer the sender can decline to honour is not a timer. The trigger reads
  the conversation's own setting and assigns unconditionally, so a modified
  client that supplied its own expires_at has it replaced. That overwrite is
  the whole point of doing this in the database.
*/
CREATE OR REPLACE FUNCTION public.stamp_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ttl integer;
BEGIN
  SELECT t.ttl_seconds INTO ttl
  FROM public.conversation_timers t
  WHERE t.user_a = least(NEW.user_id, NEW.receiver_id)
    AND t.user_b = greatest(NEW.user_id, NEW.receiver_id);

  -- Assigned unconditionally, so a client that supplied its own value has it
  -- replaced. That overwrite is the whole point of doing this here.
  NEW.expires_at := CASE WHEN ttl IS NULL THEN NULL ELSE now() + make_interval(secs => ttl) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_stamp_expiry ON public.messages;
CREATE TRIGGER messages_stamp_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_message_expiry();

CREATE OR REPLACE FUNCTION public.stamp_room_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ttl integer;
BEGIN
  SELECT r.ttl_seconds INTO ttl FROM public.rooms r WHERE r.id = NEW.room_id;
  NEW.expires_at := CASE WHEN ttl IS NULL THEN NULL ELSE now() + make_interval(secs => ttl) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS room_messages_stamp_expiry ON public.room_messages;
CREATE TRIGGER room_messages_stamp_expiry
  BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_room_message_expiry();

CREATE OR REPLACE FUNCTION public.set_conversation_timer(peer uuid, ttl integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF ttl IS NOT NULL AND ttl <= 0 THEN
    RAISE EXCEPTION 'timer must be positive or null';
  END IF;

  INSERT INTO public.conversation_timers (user_a, user_b, ttl_seconds, set_by, updated_at)
  VALUES (least(me, peer), greatest(me, peer), ttl, me, now())
  ON CONFLICT (user_a, user_b) DO UPDATE
    SET ttl_seconds = EXCLUDED.ttl_seconds,
        set_by      = EXCLUDED.set_by,
        updated_at  = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_room_timer(target uuid, ttl integer)
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
  IF ttl IS NOT NULL AND ttl <= 0 THEN
    RAISE EXCEPTION 'timer must be positive or null';
  END IF;

  UPDATE public.rooms
     SET ttl_seconds = ttl, ttl_set_by = me
   WHERE id = target;
END;
$$;

REVOKE ALL ON FUNCTION public.set_conversation_timer(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_timer(uuid, integer)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_timer(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_room_timer(uuid, integer)         TO authenticated;

-- The trigger functions are fired by the executor, never called by name.
REVOKE ALL ON FUNCTION public.stamp_message_expiry()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stamp_room_message_expiry() FROM PUBLIC, anon, authenticated;

/*
  The sweep. Scheduled by pg_cron every minute — see the note at the bottom of
  this file, because cron.schedule cannot live in a re-runnable script.
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
    FROM public.messages
   WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Best effort. The row above held the only copy of this file's key, so the
  -- bytes are already unopenable; this reclaims the listing.
  IF array_length(doomed, 1) > 0 THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 9. Push infrastructure
-- ===========================================================================

/*
  Both tables here are server-side. RLS is on and neither has a policy — that
  absence IS the lockdown, since RLS with no policy fails closed. They are
  reached by the service role and by the trigger below, and by nothing else.

  This path is opt-in and inert until `push_config` holds a row: without one
  the trigger returns immediately. The live project has no row, and background
  notifications go through OneSignal (`functions/send-push` is the older Web
  Push transport). It exists so delivery does not depend on the sender's
  browser outliving the request — sending a message and locking the phone
  aborts a client-side invoke mid-flight, and the receiver is never told.
*/

-- One row per message that has been pushed, so the database trigger and a
-- client-side invoke can both fire without the receiver getting two banners.
CREATE TABLE IF NOT EXISTS public.message_pushes (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.message_pushes ENABLE ROW LEVEL SECURITY;

-- A table rather than a database setting: `ALTER DATABASE ... SET` needs
-- privileges the Supabase SQL editor does not hand out, and Vault would tie
-- this schema to a specific project's key ids.
CREATE TABLE IF NOT EXISTS public.push_config (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  function_url   text NOT NULL,
  trigger_secret text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.push_config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.notify_push_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cfg public.push_config%ROWTYPE;
BEGIN
  -- Soft-deleted on arrival shouldn't notify; nor should anything before the
  -- function has been configured.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cfg FROM public.push_config LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := cfg.function_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-secret', cfg.trigger_secret
               ),
    body    := jsonb_build_object('message_id', NEW.id),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A notification is never worth failing a send over. If the HTTP call can't
  -- be queued the message still stores, and the sender's own invoke (which is
  -- still in place) remains as the second path.
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_push_on_message() FROM PUBLIC, anon, authenticated;

-- The WHEN clause, not the function body, is what stops a note you wrote to
-- yourself arriving on the phone in your pocket as a banner about something
-- you just typed. `send-push` refuses self-addressed messages on its own too,
-- so this is not the only defence.
DROP TRIGGER IF EXISTS notify_push_on_message ON public.messages;
CREATE TRIGGER notify_push_on_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.user_id <> NEW.receiver_id)
  EXECUTE FUNCTION public.notify_push_on_message();

-- ===========================================================================
-- 10. Theme grants
-- ===========================================================================

/*
  A theme pack is normally owned because it was bought, and RevenueCat is the
  only record of that. This table is how a pack reaches an account for a demo,
  a review build, a press screenshot or a refund gesture without either
  charging for it or shipping a debug switch in the client.

  There is no INSERT policy and the privilege is revoked. A grant the client
  could write is not a grant — it is a free unlock for anyone who can read the
  network tab, and the six packs are the only revenue this product has.
*/
CREATE TABLE IF NOT EXISTS public.theme_grants (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pack_id    text NOT NULL,
  -- Why this account has it: 'showcase', 'review build', 'refund'. Read by a
  -- human six months from now who is deciding whether it can be removed.
  note       text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id)
);

ALTER TABLE public.theme_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS theme_grants_select_own ON public.theme_grants;
CREATE POLICY theme_grants_select_own ON public.theme_grants
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- RLS alone would already refuse the write; revoking the privilege means a
-- policy added carelessly later cannot quietly open the till.
REVOKE ALL ON public.theme_grants FROM anon;
REVOKE ALL ON public.theme_grants FROM authenticated;
GRANT SELECT ON public.theme_grants TO authenticated;

-- Must match `PACKS` in src/lib/purchases.ts; theme-grants.test.ts reads
-- 0030_theme_grants.sql and fails if a pack in the client is missing.
CREATE OR REPLACE FUNCTION public.all_theme_packs()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'pack.midnight',
    'pack.paper',
    'pack.terminal',
    'pack.sunset',
    'pack.sakura',
    'pack.graphite'
  ]::text[];
$$;

/*
  SECURITY DEFINER because auth.users is not readable by anyone else, and an
  email is the only handle a human running this actually has. That makes the
  EXECUTE grant the whole security story, which is why it is revoked from every
  role — including `authenticated`, which would otherwise be able to award
  itself the entire catalogue with one RPC call.
*/
CREATE OR REPLACE FUNCTION public.grant_theme_packs(
  p_email    text,
  p_pack_ids text[] DEFAULT NULL,
  p_note     text DEFAULT 'showcase'
)
RETURNS TABLE (pack_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- The RETURNS TABLE column is itself a plpgsql variable named pack_id, which
-- makes the ON CONFLICT target below ambiguous and the function fail at call
-- time rather than at creation. Column wins.
#variable_conflict use_column
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no account with email %', p_email;
  END IF;
  -- The foreign key would say this too, but as a constraint violation naming a
  -- uuid nobody typed. An account can exist without a profile row between
  -- signup and the trigger that creates one.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'account % has no profile row yet', p_email;
  END IF;

  RETURN QUERY
  INSERT INTO public.theme_grants AS g (user_id, pack_id, note)
  SELECT v_user_id, p.id, p_note
    FROM unnest(COALESCE(p_pack_ids, public.all_theme_packs())) AS p(id)
  ON CONFLICT (user_id, pack_id) DO UPDATE SET note = EXCLUDED.note
  RETURNING g.pack_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_theme_grants(
  p_email    text,
  p_pack_ids text[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_removed integer;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no account with email %', p_email;
  END IF;

  DELETE FROM public.theme_grants
   WHERE user_id = v_user_id
     AND (p_pack_ids IS NULL OR pack_id = ANY (p_pack_ids));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.all_theme_packs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_theme_packs(text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_theme_grants(text, text[]) FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- 11. The RPCs the client calls
-- ===========================================================================

/*
  The sidebar, in one round trip.

  It returns no message text, because there is none the server could return —
  previews come from the device's local mirror. What it does return is
  metadata the server legitimately has: ordering, who spoke last, and whether
  the last thing was an attachment.

  SECURITY INVOKER (the default): the existing RLS on friendships, profiles and
  messages already scopes every row this reads, so no elevated rights are
  needed. A friend you have not accepted produces no row.

  UNION ALL, not UNION: `peers` cannot already contain the caller — no
  friendship names you as your own friend — so deduplicating would only cost a
  sort. The self row is always present, which is how a never-used notes chat
  still appears.
*/
CREATE OR REPLACE FUNCTION public.conversation_list()
RETURNS TABLE(
  peer_id uuid,
  display_name text,
  avatar_url text,
  last_media_type text,
  last_sender_id uuid,
  last_at timestamptz,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH peers AS (
    SELECT CASE
             WHEN f.requester_id = (select auth.uid()) THEN f.addressee_id
             ELSE f.requester_id
           END AS peer_id
    FROM public.friendships f
    WHERE f.status = 'accepted'
      AND (select auth.uid()) IN (f.requester_id, f.addressee_id)
    UNION ALL
    -- The conversation with yourself, always present.
    SELECT (select auth.uid())
  ),
  latest AS (
    SELECT DISTINCT ON (p.peer_id)
           p.peer_id,
           m.media_type AS last_media_type,
           m.user_id    AS last_sender_id,
           m.created_at AS last_at
    FROM peers p
    LEFT JOIN public.messages m
      ON m.deleted_at IS NULL
     AND (
           (m.user_id = (select auth.uid()) AND m.receiver_id = p.peer_id)
           OR (m.user_id = p.peer_id AND m.receiver_id = (select auth.uid()))
         )
    ORDER BY p.peer_id, m.created_at DESC NULLS LAST
  )
  SELECT l.peer_id,
         pr.display_name,
         pr.avatar_url,
         l.last_media_type,
         l.last_sender_id,
         l.last_at,
         pr.last_seen_at
  FROM latest l
  JOIN public.profiles pr ON pr.id = l.peer_id;
$$;

REVOKE ALL ON FUNCTION public.conversation_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_list() TO authenticated;

/*
  Per-peer unread tally.

  Own-sent messages are excluded, which does two things. It stops every
  self-note counting as unread forever — `no_self_receipt` forbids the
  (me, me) watermark row from existing, so `r.read_at IS NULL` would be
  permanently true and the badge would climb with every note and never come
  down. And it hardens the ordinary case: a message you sent could never be
  unread to you either.
*/
CREATE OR REPLACE FUNCTION public.unread_counts()
RETURNS TABLE (peer_id uuid, unread bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT m.user_id AS peer_id, count(*) AS unread
  FROM public.messages m
  LEFT JOIN public.message_receipts r
    ON r.user_id = (select auth.uid())
   AND r.peer_id = m.user_id
  WHERE m.receiver_id = (select auth.uid())
    AND m.user_id <> (select auth.uid())
    AND m.deleted_at IS NULL
    AND (r.read_at IS NULL OR m.created_at > r.read_at)
  GROUP BY m.user_id;
$$;

REVOKE ALL ON FUNCTION public.unread_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unread_counts() TO authenticated;

/*
  The room list with member counts, in one round trip. Client-side this is one
  query for rooms, one for participants and one for the newest message per
  room, then a join in JavaScript — three requests on every sidebar refresh.
*/
CREATE OR REPLACE FUNCTION public.rooms_for_me()
RETURNS TABLE (
  id           uuid,
  title        text,
  created_by   uuid,
  created_at   timestamptz,
  member_count bigint,
  last_at      timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT r.id,
         r.title,
         r.created_by,
         r.created_at,
         (SELECT count(*) FROM public.room_participants p WHERE p.room_id = r.id),
         (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id)
    FROM public.rooms r
   WHERE EXISTS (
           SELECT 1 FROM public.room_participants me
            WHERE me.room_id = r.id AND me.user_id = (SELECT auth.uid())
         )
   ORDER BY coalesce(
              (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id),
              r.created_at
            ) DESC;
$$;

REVOKE ALL ON FUNCTION public.rooms_for_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rooms_for_me() TO authenticated;

/*
  The table names in `public`, for the transparency screen.

  A hard-coded list of "what the server knows" goes stale the moment a
  migration adds a table, and it goes stale silently — the screen would keep
  making a true-sounding claim about a database that had changed underneath it.
  Reading the real list lets the client render "there is a table here nobody
  has described" instead of a confident lie.

  An RPC rather than a view because information_schema is not exposed through
  PostgREST, and exposing it would hand out far more than names. Table names
  are not user data: every one of them is in this repository.
*/
CREATE OR REPLACE FUNCTION public.public_table_names()
RETURNS TABLE (table_name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
   ORDER BY c.relname;
$$;

REVOKE ALL ON FUNCTION public.public_table_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_table_names() TO authenticated;

-- ===========================================================================
-- 12. Realtime
-- ===========================================================================

/*
  REPLICA IDENTITY FULL on four of these: without it, a DELETE's or UPDATE's
  old record arrives as bare key columns that realtime cannot evaluate the
  SELECT policy against, and the event never reaches the client. For
  chat_backgrounds and friend_nicknames — which nobody but the owner can see —
  realtime is not what makes the feature work; it keeps one user's own devices
  in step.

  ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS: a second run raises
  42710 and aborts the whole script. Every add is guarded so this file stays
  re-runnable.
*/
ALTER TABLE public.friendships       REPLICA IDENTITY FULL;
ALTER TABLE public.message_receipts  REPLICA IDENTITY FULL;
ALTER TABLE public.chat_backgrounds  REPLICA IDENTITY FULL;
ALTER TABLE public.friend_nicknames  REPLICA IDENTITY FULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages',
    'message_reactions',
    'message_receipts',
    'friendships',
    'chat_backgrounds',
    'friend_nicknames',
    'room_messages',
    'room_participants'
  ] LOOP
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

-- ===========================================================================
-- 13. Schema cache
-- ===========================================================================

-- PostgREST answers from a cached view of the schema. It normally picks up DDL
-- on its own, but a table created in the SQL editor can stay invisible to the
-- Data API until it does — requests fail with PGRST205 "Could not find the
-- table in the schema cache" even though the table plainly exists. Ask for the
-- reload rather than waiting for it.
NOTIFY pgrst, 'reload schema';

/*
  ===========================================================================
  Two things this file cannot do
  ===========================================================================

  1. Storage. Run `storage/setup.sql` after this file: it creates the `avatars`
     and `chat-media` buckets and their policies on storage.objects.

  2. The expiry sweep. pg_cron must be enabled on the project first
     (Database → Extensions → pg_cron), and cron.schedule fails with a
     duplicate-jobname error if re-run, which would make this whole file unsafe
     to re-run. Once, in the SQL editor:

       SELECT cron.schedule(
         'nearside-expire',
         '* * * * *',
         $cron$ SELECT public.expire_messages(); $cron$
       );

     Without it the columns and triggers exist and stamp correctly, and nothing
     is ever deleted. To change it later:

       SELECT cron.unschedule('nearside-expire');
*/
