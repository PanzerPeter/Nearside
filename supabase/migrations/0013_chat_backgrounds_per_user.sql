/*
  Nearside — chat backgrounds become per-user
  Run once in the Supabase SQL editor after 0012.

  0012 gave each conversation one background that both participants shared.
  This replaces it with one background per user per conversation: A's choice in
  the chat with B is A's alone, and B sets their own independently.

  The table is replaced rather than altered. The old primary key was the sorted
  participant pair; the new one is (owner, peer), where order is meaningful —
  that is not an ALTER, it is a different table. Going via a rename also clears
  the old policies, trigger and publication membership in one step, so no
  pair-era policy can survive alongside the new ones.

  Existing rows are carried over, not discarded: a shared background becomes the
  personal background of whoever set it (`set_by`), and the other participant
  starts with none. That is the only reading of the old row that is true under
  the new rules, and it keeps `media_path` pointing at an object that is still
  in storage — a plain drop would strand that file with nothing referencing it.

  Re-runnable, and safe on a database that never ran 0012: the carry-over is
  skipped when there is no pair-shaped table to read.

  Security notes:
    - RLS enabled; every policy scopes rows to owner_id = auth.uid(). A user can
      neither read nor write another user's background, including their peer's
      for the same conversation.
    - Writes still require an accepted friendship, mirroring
      messages_insert_sender (0001), so the table cannot be filled with rows
      naming arbitrary users.
    - Privileges granted explicitly to `authenticated`; anon revoked.
    - The UPDATE policy carries both USING and WITH CHECK.
*/

-- ============================================================
-- 0. Set the pair-shaped table aside
-- ============================================================
-- Detected by column, not by existence: the table name is the same in both
-- shapes, so `to_regclass` alone cannot tell a 0012 table from a table this
-- file already created on an earlier run.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chat_backgrounds'
      AND column_name = 'user_a'
  ) THEN
    ALTER TABLE public.chat_backgrounds RENAME TO chat_backgrounds_pair_legacy;
  END IF;
END;
$$;

-- ============================================================
-- 1. chat_backgrounds
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_backgrounds (
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  peer_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  media_path text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, peer_id),
  CONSTRAINT no_self_background CHECK (owner_id <> peer_id),
  CONSTRAINT media_path_length CHECK (char_length(media_path) BETWEEN 1 AND 512)
);

-- The PK indexes (owner_id, peer_id); peer_id needs its own for the FK.
CREATE INDEX IF NOT EXISTS chat_backgrounds_peer_idx
  ON public.chat_backgrounds (peer_id);

ALTER TABLE public.chat_backgrounds ENABLE ROW LEVEL SECURITY;

-- Privileges are the gate before RLS, not a substitute for it.
REVOKE ALL ON public.chat_backgrounds FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_backgrounds TO authenticated;

DROP TRIGGER IF EXISTS chat_backgrounds_set_updated_at ON public.chat_backgrounds;
CREATE TRIGGER chat_backgrounds_set_updated_at
  BEFORE UPDATE ON public.chat_backgrounds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. RLS — owner-only, in every direction
-- ============================================================
DROP POLICY IF EXISTS "chat_backgrounds_select_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_select_own" ON public.chat_backgrounds
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = owner_id);

DROP POLICY IF EXISTS "chat_backgrounds_insert_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_insert_own" ON public.chat_backgrounds
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
          OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
    )
  );

-- Replacing a background is an upsert, so the same gate has to hold on UPDATE.
DROP POLICY IF EXISTS "chat_backgrounds_update_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_update_own" ON public.chat_backgrounds
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id)
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND ((f.requester_id = owner_id AND f.addressee_id = peer_id)
          OR (f.requester_id = peer_id AND f.addressee_id = owner_id))
    )
  );

-- Clearing is deliberately not friendship-gated: after a defriend you should
-- still be able to drop your own row.
DROP POLICY IF EXISTS "chat_backgrounds_delete_own" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_delete_own" ON public.chat_backgrounds
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

-- ============================================================
-- 2b. Carry over the pair-era rows, then retire the old table
-- ============================================================
-- Runs as the migration's own role, so RLS on the new table is not in the way.
-- ON CONFLICT DO NOTHING keeps a re-run idempotent: a row already carried over
-- wins over the legacy copy.
DO $$
BEGIN
  IF to_regclass('public.chat_backgrounds_pair_legacy') IS NOT NULL THEN
    INSERT INTO public.chat_backgrounds (owner_id, peer_id, media_path, updated_at)
    SELECT old.set_by,
           CASE WHEN old.set_by = old.user_a THEN old.user_b ELSE old.user_a END,
           old.media_path,
           old.updated_at
    FROM public.chat_backgrounds_pair_legacy old
    ON CONFLICT (owner_id, peer_id) DO NOTHING;

    DROP TABLE public.chat_backgrounds_pair_legacy;
  END IF;
END;
$$;

-- ============================================================
-- 3. Realtime
-- ============================================================
-- The peer no longer has any stake in this row, so realtime is not what makes
-- the feature work — it keeps one user's own devices in step, which is why it
-- is still worth streaming. FULL so a DELETE's old record carries the keys the
-- client filters on.
ALTER TABLE public.chat_backgrounds REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_backgrounds'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_backgrounds;
  END IF;
END;
$$;

-- ============================================================
-- 4. Schema cache
-- ============================================================
-- DROP + CREATE changes the table's columns, so PostgREST's cached view of it
-- is stale until it reloads. Ask rather than wait.
NOTIFY pgrst, 'reload schema';
