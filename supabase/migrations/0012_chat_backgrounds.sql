/*
  Chatly — per-conversation chat backgrounds
  Run once in the Supabase SQL editor after 0011.

  Contents:
    1. chat_backgrounds — one background image per 1:1 conversation
    2. RLS              — participants read; participants who are still friends
                          write; either participant clears
    3. Realtime         — chat_backgrounds added to the publication so a change
                          lands without reopening the chat

  Design notes:
    - There is no `conversations` table in this schema; a DM is identified by
      the unordered pair of participant ids (see conversationKey() in
      src/lib/conversation.ts). The primary key here is that pair, stored in
      sorted order and held that way by the `ordered_pair` CHECK, so (A,B) and
      (B,A) cannot both exist. One row per conversation is therefore a database
      invariant, not a convention: "replace the background" is a plain upsert,
      with no window in which a conversation has two.
    - The image itself lives in the existing private `chat-media` bucket under
      the same {uidA}_{uidB} folder the conversation's media already uses, so
      storage-setup.sql needs no new bucket or policy. The per-conversation
      media cap trims by walking `messages` rows, never by listing the folder,
      so it will not sweep a background out from under this table.

  Security notes:
    - RLS enabled; every policy scopes rows to the two participants.
    - Writes additionally require an accepted friendship, mirroring the gate on
      messages_insert_sender (0001). Without it, a removed friend would keep
      write access to a chat they can no longer post in.
    - The UPDATE policy carries both USING and WITH CHECK.
    - Table privileges are granted explicitly to `authenticated` only, and anon
      is revoked. The older tables in this schema rely on Supabase's historical
      default of auto-granting every new public table to anon/authenticated;
      that default is being changed to opt-in, so a table created today can end
      up reachable by no client role at all — which surfaces as 42501
      "permission denied", not as an RLS denial. Granting here makes this file
      independent of when the project was created.
*/

-- ============================================================
-- 1. chat_backgrounds
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_backgrounds (
  user_a     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  media_path text NOT NULL,
  set_by     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT ordered_pair CHECK (user_a < user_b),
  CONSTRAINT media_path_length CHECK (char_length(media_path) BETWEEN 1 AND 512)
);

-- The PK indexes (user_a, user_b); the reverse lookup and the user_b FK need
-- their own index.
CREATE INDEX IF NOT EXISTS chat_backgrounds_user_b_idx
  ON public.chat_backgrounds (user_b);
CREATE INDEX IF NOT EXISTS chat_backgrounds_set_by_idx
  ON public.chat_backgrounds (set_by);

ALTER TABLE public.chat_backgrounds ENABLE ROW LEVEL SECURITY;

-- Privileges are the gate before RLS, not a substitute for it: RLS above still
-- decides which rows each authenticated user may touch.
REVOKE ALL ON public.chat_backgrounds FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_backgrounds TO authenticated;

DROP TRIGGER IF EXISTS chat_backgrounds_set_updated_at ON public.chat_backgrounds;
CREATE TRIGGER chat_backgrounds_set_updated_at
  BEFORE UPDATE ON public.chat_backgrounds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. RLS
-- ============================================================
DROP POLICY IF EXISTS "chat_backgrounds_select_participant" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_select_participant" ON public.chat_backgrounds
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_a, user_b));

DROP POLICY IF EXISTS "chat_backgrounds_insert_participant" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_insert_participant" ON public.chat_backgrounds
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) IN (user_a, user_b)
    AND set_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND ((f.requester_id = user_a AND f.addressee_id = user_b)
          OR (f.requester_id = user_b AND f.addressee_id = user_a))
    )
  );

-- Replacing an existing background is an upsert, so the same gate has to hold
-- on UPDATE. USING keeps a non-participant from targeting the row at all;
-- WITH CHECK keeps the row a participant row after the write.
DROP POLICY IF EXISTS "chat_backgrounds_update_participant" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_update_participant" ON public.chat_backgrounds
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) IN (user_a, user_b))
  WITH CHECK (
    (select auth.uid()) IN (user_a, user_b)
    AND set_by = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND ((f.requester_id = user_a AND f.addressee_id = user_b)
          OR (f.requester_id = user_b AND f.addressee_id = user_a))
    )
  );

-- Clearing is deliberately not friendship-gated: after a defriend, either side
-- should still be able to drop the image.
DROP POLICY IF EXISTS "chat_backgrounds_delete_participant" ON public.chat_backgrounds;
CREATE POLICY "chat_backgrounds_delete_participant" ON public.chat_backgrounds
  FOR DELETE TO authenticated
  USING ((select auth.uid()) IN (user_a, user_b));

-- ============================================================
-- 3. Realtime
-- ============================================================
-- FULL, not the default primary-key identity: without it a DELETE's old record
-- arrives as bare key columns that realtime cannot evaluate the SELECT policy
-- against, so clearing a background would never reach the peer.
ALTER TABLE public.chat_backgrounds REPLICA IDENTITY FULL;

-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS; a second run would
-- raise 42710 and abort the script. Guarded, same as 0001/0004/0006.
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
-- PostgREST answers from a cached view of the schema. It normally picks up DDL
-- on its own, but a table created in the SQL editor can stay invisible to the
-- Data API until it does — requests fail with PGRST205 "Could not find the
-- table in the schema cache" even though the table plainly exists. Ask for the
-- reload rather than waiting for it.
NOTIFY pgrst, 'reload schema';
