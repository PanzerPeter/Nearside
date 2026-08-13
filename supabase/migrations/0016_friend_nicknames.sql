/*
  Nearside — private friend nicknames
  Run once in the Supabase SQL editor after 0015. Re-runnable.

  What this is:
    A name you give someone, visible only to you. You call @bob "Bobby"; Bob
    never learns that, and neither does anybody else. The shared-nickname model
    (both participants see and can change one label, as in Messenger) was
    deliberately not chosen: it lets one person relabel the other, which is a
    harassment vector in a two-person app with no moderation.

  Shape:
    One row per (owner, peer), exactly like chat_backgrounds (0013) — the
    established "private per-user setting about a peer" pattern here. The
    username stays the identity; a nickname is only a label on top of it, so
    nothing about uniqueness or lookup changes.

  Self-nicknames are allowed on purpose (no owner <> peer CHECK): the self-chat
  from 0017 is addressed as peer_id = owner_id, so this is what lets someone
  rename "Note to self" without a second mechanism.

  Security notes:
    - RLS enabled; every policy scopes rows to owner_id = auth.uid(). A peer can
      neither read nor write the nickname you hold for them, which is the whole
      point of the feature.
    - Writes require an accepted friendship (or the self row), mirroring
      messages_insert_sender (0001), so the table cannot be filled with rows
      naming arbitrary users — it is not a private notes field about strangers.
    - Clearing is deliberately NOT friendship-gated: after a defriend you must
      still be able to drop your own row.
    - The UPDATE policy carries both USING and WITH CHECK.
    - Privileges granted explicitly to `authenticated`; anon revoked.
*/

-- ============================================================
-- 1. friend_nicknames
-- ============================================================
CREATE TABLE IF NOT EXISTS public.friend_nicknames (
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nickname   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, peer_id),
  -- Length is measured after trimming, so " " cannot pass as a one-character
  -- nickname and leave a row that renders as a blank name.
  CONSTRAINT nickname_length CHECK (char_length(btrim(nickname)) BETWEEN 1 AND 32),
  -- A nickname is displayed inline in the sidebar and the chat header, so a
  -- newline or other control character would break that line. Rejected at the
  -- column rather than trusted to be stripped by whichever client wrote it.
  CONSTRAINT nickname_single_line CHECK (nickname ~ '^[^[:cntrl:]]+$')
);

-- The PK indexes (owner_id, peer_id); peer_id needs its own for the FK.
CREATE INDEX IF NOT EXISTS friend_nicknames_peer_idx
  ON public.friend_nicknames (peer_id);

ALTER TABLE public.friend_nicknames ENABLE ROW LEVEL SECURITY;

-- Privileges are the gate before RLS, not a substitute for it.
REVOKE ALL ON public.friend_nicknames FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friend_nicknames TO authenticated;

DROP TRIGGER IF EXISTS friend_nicknames_set_updated_at ON public.friend_nicknames;
CREATE TRIGGER friend_nicknames_set_updated_at
  BEFORE UPDATE ON public.friend_nicknames
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. RLS — owner-only, in every direction
-- ============================================================
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

-- Renaming is an upsert, so the same gate has to hold on UPDATE.
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

-- ============================================================
-- 3. Realtime
-- ============================================================
-- Nobody but the owner can see these rows, so realtime is not what makes the
-- feature work — it keeps one user's own devices in step, same reasoning as
-- chat_backgrounds (0013). FULL so a DELETE's old record carries the keys the
-- client filters on.
ALTER TABLE public.friend_nicknames REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'friend_nicknames'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_nicknames;
  END IF;
END;
$$;

-- ============================================================
-- 4. Schema cache
-- ============================================================
-- A brand-new table is invisible to PostgREST until it reloads. Ask rather
-- than wait, or the first client write comes back PGRST205.
NOTIFY pgrst, 'reload schema';
