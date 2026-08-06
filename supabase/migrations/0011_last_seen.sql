/*
  Chatly — persisted last-seen
  Run once in the Supabase SQL editor after 0010.

  Realtime presence is ephemeral: it says whether someone is connected right
  now and nothing about when they last were. This column is the durable half.

  Security notes:
    - No new policy needed. profiles_update_own already limits writes to your
      own row, and profiles_select_connected (0008) already limits reads to
      your friends — which is exactly who should see your last-seen.

  conversation_list() is re-declared here (not just altered) so this file
  stays independently re-runnable: the function body is copied whole from
  0007_conversation_list.sql with last_seen_at added, rather than left for a
  later migration to patch in.
*/

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- CREATE OR REPLACE cannot change a RETURNS TABLE function's output columns
-- (adding last_seen_at changes the OUT-parameter list) — Postgres errors with
-- "cannot change return type of existing function" unless the old signature
-- is dropped first. DROP ... IF EXISTS keeps this re-runnable either way.
DROP FUNCTION IF EXISTS public.conversation_list();

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
