/*
  Nearside — message search
  Run once in the Supabase SQL editor after 0009.

  Contents:
    1. pg_trgm + a GIN index on messages.content
    2. search_messages() — substring search within one conversation

  Security notes:
    - SECURITY INVOKER: messages_select_participant already restricts rows to
      the two participants, so the function cannot reach a conversation the
      caller is not in, whatever `peer` is passed.

  Wildcard note:
    A naive `content ILIKE '%' || q || '%'` treats '%' and '_' typed by the
    user as LIKE wildcards rather than literal characters — searching for
    "50% off" would match "50X off", and any content containing a stray
    underscore would over-match. The needle is escaped before it reaches the
    pattern (with an ESCAPE clause) so ILIKE still gets to use the trgm
    index, but every character in it is matched literally.
*/

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
  ON public.messages USING gin (content gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_messages(peer uuid, q text)
RETURNS TABLE (id uuid, user_id uuid, content text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  needle  text := btrim(coalesce(q, ''));
  pattern text;
BEGIN
  IF length(needle) < 2 THEN
    RETURN;
  END IF;

  -- Backslash first, then the two LIKE metacharacters — escaping '%'/'_'
  -- before the backslash would double-escape the backslashes just added.
  pattern := '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT m.id, m.user_id, m.content, m.created_at
  FROM public.messages m
  WHERE m.deleted_at IS NULL
    AND m.content IS NOT NULL
    AND (
          (m.user_id = (select auth.uid()) AND m.receiver_id = peer)
          OR (m.user_id = peer AND m.receiver_id = (select auth.uid()))
        )
    AND m.content ILIKE pattern ESCAPE '\'
  ORDER BY m.created_at DESC
  LIMIT 50;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_messages(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_messages(uuid, text) TO authenticated;
