/*
  Chatly — conversation list RPC
  Run once in the Supabase SQL editor after 0006.

  !! SUPERSEDED BY 0011 — DO NOT RE-RUN AFTER 0011 !!
    0011 re-declares conversation_list() with an eighth column (last_seen_at),
    dropping it first because Postgres cannot change a RETURNS TABLE signature
    via CREATE OR REPLACE. That same rule means this file's 7-column version
    can no longer replace the 8-column one: re-running it raises
    "cannot change return type of existing function" and aborts. It holds
    nothing 0011 doesn't; it is kept only as the historical record.

  Contents:
    1. conversation_list() — one row per accepted friend, carrying that
       friendship's most recent message and when it landed

  Why an RPC:
    The sidebar needs "newest activity first", which is a per-friend
    DISTINCT ON over messages. Doing that client-side costs one query per
    friend and still cannot sort correctly until every one of them returns.

  Security notes:
    - SECURITY INVOKER: the existing RLS on friendships, profiles and
      messages already scopes every row this reads, so no elevated rights
      are needed. A friend you have not accepted produces no row.
    - Deleted messages are excluded from the preview, but the row still
      appears — an all-deleted conversation shows a null preview rather
      than vanishing from your sidebar.
*/

CREATE OR REPLACE FUNCTION public.conversation_list()
RETURNS TABLE (
  peer_id         uuid,
  username        text,
  avatar_url      text,
  last_message    text,
  last_media_type text,
  last_sender_id  uuid,
  last_at         timestamptz
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
         l.last_at
  FROM latest l
  JOIN public.profiles pr ON pr.id = l.peer_id;
$$;

REVOKE EXECUTE ON FUNCTION public.conversation_list() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.conversation_list() TO authenticated;
