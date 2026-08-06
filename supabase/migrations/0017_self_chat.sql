/*
  Chatly — the conversation with yourself
  Run once in the Supabase SQL editor after 0016. Re-runnable.

  What this is:
    A note-to-self chat, present for every user from the start, addressed as
    `user_id = receiver_id = auth.uid()`. No new table and no new message kind:
    it is an ordinary row of `public.messages` whose two participants are the
    same person, so every feature already built on that table — media, voice
    notes, replies, reactions, edit, soft-delete, search, pagination, the media
    retention cap — works in it untouched.

    No friendship row backs it. `no_self_friend` (0001) forbids one, and
    inventing an exception there would leak into every query that treats
    `friendships` as "people you can talk to". Instead the self case is named
    explicitly in the four places that actually gate on it, below.

  Contents:
    1. messages_insert_sender  — allow a message addressed to yourself
    2. unread_counts()         — your own notes are read by definition
    3. conversation_list()     — your own row, always, even when empty
    4. chat_backgrounds        — allow a background on the self-chat
    5. notify_push_on_message  — never push someone their own note

  Security notes:
    - The INSERT policy still pins `user_id` to `auth.uid()`. The added branch
      widens *who you may address* by exactly one person — yourself — and
      cannot be used to reach anyone else: `receiver_id = user_id` and
      `user_id = auth.uid()` together leave only one possible receiver.
    - `messages_prevent_reassign` (0005) still makes both participants
      immutable, so a self-note cannot later be repointed at a stranger. That
      trigger is what keeps this from becoming an unsolicited-DM vector.
    - Nothing here widens SELECT. `messages_select_participant` already reads
      `auth.uid() IN (user_id, receiver_id)`, which for a self-row is the
      author and nobody else.
    - No receipt rows are involved: `no_self_receipt` (0006) stays as it is,
      and step 2 is what stops its absence being read as "unread".
*/

-- ============================================================
-- 1. Sending to yourself
-- ============================================================
-- The friendship EXISTS is unchanged; a second branch is added beside it. Both
-- still sit under `auth.uid() = user_id`, so this cannot be used to write a
-- message as somebody else.
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

-- ============================================================
-- 2. Your own notes are never unread
-- ============================================================
-- Without this, every self-note counts as unread forever: the LEFT JOIN looks
-- for a watermark row keyed (auth.uid(), auth.uid()), `no_self_receipt` (0006)
-- forbids that row from ever existing, so `r.read_at IS NULL` is permanently
-- true. The badge would climb with every note written and never come down.
--
-- Excluding own-sent messages is the correct fix rather than relaxing
-- no_self_receipt: writing yourself a receipt to say you read what you just
-- typed is bookkeeping with no reader. Note this also hardens the ordinary
-- case — a message you sent could never be unread to you either.
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

REVOKE EXECUTE ON FUNCTION public.unread_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.unread_counts() TO authenticated;

-- ============================================================
-- 3. The self row in the sidebar
-- ============================================================
-- `peers` gained one row: yourself. Everything downstream already handles it —
-- the LEFT JOIN yields a null preview for a chat with no messages (which is how
-- a never-used notes chat still appears), and the JOIN to profiles resolves
-- because profiles_select_connected (0008) allows reading your own row.
--
-- The column list is unchanged from 0011, so this is a plain CREATE OR REPLACE:
-- no DROP is needed, and none is done, because dropping would also drop the
-- grant below on a partially-applied run.
--
-- UNION ALL, not UNION: `peers` cannot contain the caller already (no
-- friendship names you as your own friend), so deduplicating would only cost a
-- sort. `last_seen_at` for your own row is your own, which the client does not
-- render for the self-chat.
CREATE OR REPLACE FUNCTION public.conversation_list()
RETURNS TABLE (
  peer_id         uuid,
  username        text,
  avatar_url      text,
  last_message    text,
  last_media_type text,
  last_sender_id  uuid,
  last_at         timestamptz,
  last_seen_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
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
           m.content    AS last_message,
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
         pr.username,
         pr.avatar_url,
         l.last_message,
         l.last_media_type,
         l.last_sender_id,
         l.last_at,
         pr.last_seen_at
  FROM latest l
  JOIN public.profiles pr ON pr.id = l.peer_id;
$$;

REVOKE EXECUTE ON FUNCTION public.conversation_list() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.conversation_list() TO authenticated;

-- ============================================================
-- 4. A background for the self-chat
-- ============================================================
-- 0013 forbade owner = peer because a "conversation with yourself" did not
-- exist yet. It does now, and it is a chat like any other, so it gets the same
-- backdrop. The two write policies are re-created with the self branch the
-- messages policy above uses; SELECT and DELETE were never friendship-gated
-- and are left alone.
ALTER TABLE public.chat_backgrounds DROP CONSTRAINT IF EXISTS no_self_background;

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

-- ============================================================
-- 5. Never push someone their own note
-- ============================================================
-- The 0014 trigger fires on every insert into `messages`, including a note you
-- wrote to yourself — which would arrive on the phone in your pocket as a banner
-- about something you just typed. A WHEN clause is the whole fix: the condition
-- belongs to the trigger, not the function, so 0014's body is not copied here
-- and cannot drift from it.
--
-- Two things this deliberately does NOT do:
--   - It does not create the function. 0014 is optional (see SETUP.md), and on a
--     database that never ran it there is no trigger to guard and nothing to do.
--     Guarded with to_regprocedure rather than assumed: a plain CREATE TRIGGER
--     would abort this migration on such a database, and being the last section,
--     that abort would make an otherwise complete run look like a failure.
--   - It does not make the guard the only defence. Re-running 0014 after this
--     file recreates the trigger without the WHEN clause and silently undoes it,
--     so `send-push` refuses self-addressed messages on its own. If you apply
--     0014 later, re-run this file after it.
DO $$
BEGIN
  IF to_regprocedure('public.notify_push_on_message()') IS NULL THEN
    RAISE NOTICE 'push trigger not installed (0014 not applied) - nothing to guard';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS notify_push_on_message ON public.messages;
  CREATE TRIGGER notify_push_on_message
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.user_id <> NEW.receiver_id)
    EXECUTE FUNCTION public.notify_push_on_message();
END;
$$;

-- ============================================================
-- 6. Schema cache
-- ============================================================
-- Function signatures did not change, but PostgREST caches the RPCs it exposes;
-- asking for a reload makes the widened conversation_list() take effect at once
-- rather than on the next restart.
NOTIFY pgrst, 'reload schema';
