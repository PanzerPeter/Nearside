/*
  Nearside — the server stops reading message bodies

  Contents:
    1. search_messages()         — dropped
    2. messages_content_trgm_idx — dropped
    3. legacy plaintext rows     — deleted
    4. messages.content          — dropped
    5. has_body                  — rebuilt over the columns that survive
    6. conversation_list()       — rebuilt without last_message

  Why all of them together:
    They are one idea. Each is a place where Postgres reads a message body, and
    leaving any of them would leave the claim in spec §1 false while appearing
    to be true.

  What the client does instead:
    Previews and search read the local SQLite mirror built as messages are
    decrypted for display (Plan 3 Task 1). The list still gets last_at and
    last_sender_id from here, because ordering and the "you:" prefix are
    metadata the server legitimately has.

  Irreversible:
    Dropping content destroys any body still stored in plaintext. Every writer
    seals bodies as of Plan 3 Task 2.
*/

DROP FUNCTION IF EXISTS public.search_messages(uuid, text);
DROP INDEX IF EXISTS public.messages_content_trgm_idx;

/*
  Legacy plaintext rows must go before the column does.

  Rows written before 0021 have content and nothing else — no ciphertext, no
  media_path. Dropping content leaves them with no body at all, which is both
  a bubble that can never render and a row the rebuilt has_body below refuses,
  failing the whole migration with "check constraint is violated by some row".

  Deleting them is not data loss beyond what DROP COLUMN already commits to:
  their only body is the column being destroyed in the next statement.
*/
DELETE FROM public.messages
 WHERE ciphertext IS NULL
   AND media_path IS NULL
   AND deleted_at IS NULL;

ALTER TABLE public.messages DROP COLUMN IF EXISTS content;

/*
  has_body must be rebuilt, not merely left alone.

  DROP COLUMN cascades to every CHECK constraint that mentions the column, so
  the has_body that 0021 widened disappears silently along with content. A
  dropped constraint raises no error and shows up only as an empty row weeks
  later.

  Tombstones are exempt, and must be. deleteMessage strips the body, the
  ciphertext and the media path — having nothing left is the entire point of a
  deletion. Under 0001 the row survived only because it wrote content = '' as
  a placeholder, and that column is gone as of this migration.
*/
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS has_body;
ALTER TABLE public.messages ADD CONSTRAINT has_body
  CHECK (deleted_at IS NOT NULL
      OR ciphertext IS NOT NULL
      OR media_path IS NOT NULL);

/*
  The sidebar, without the body.

  Body copied from 0022_display_name.sql (itself from 0017_self_chat.sql, which
  is what was live — NOT 0007, which two later migrations had already
  replaced). The only changes are the removal of m.content AS last_message from
  the selection and last_message from the signature.
*/
DROP FUNCTION IF EXISTS public.conversation_list();

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
