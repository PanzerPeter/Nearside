/*
  Chatly — reactions + replies
  Run once in the Supabase SQL editor after 0002.

  Contents:
    1. messages.reply_to_id  — optional single-level quote reference
    2. message_reactions     — per-user emoji reactions on a message
    3. Realtime              — message_reactions added to the publication

  Security notes:
    - RLS enabled on message_reactions; select/insert scoped to the parent
      message's conversation participants, delete scoped to the reaction owner.
*/

-- ============================================================
-- 1. messages.reply_to_id
-- ============================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid
  REFERENCES public.messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON public.messages (reply_to_id);

-- ============================================================
-- 2. message_reactions
-- ============================================================
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

-- select: only participants of the parent message's conversation
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

-- insert: your own row, and only on a message you participate in
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

-- delete: only your own reaction
DROP POLICY IF EXISTS "reactions_delete_own" ON public.message_reactions;
CREATE POLICY "reactions_delete_own" ON public.message_reactions
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================================
-- 3. Realtime
-- ============================================================
-- No IF NOT EXISTS on ALTER PUBLICATION: a second run raises 42710 and aborts
-- the whole script. Guard it so this migration stays re-runnable, same as 0006.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'message_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;
  END IF;
END;
$$;
