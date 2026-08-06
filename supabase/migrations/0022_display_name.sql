/*
  Nearside — display names replace handles

  Contents:
    1. profiles.username  — UNIQUE and format constraints dropped, renamed to
                            display_name
    2. handle_new_user()  — rebuilt for the new column
    3. search_profiles()  — rebuilt for the new column
    4. conversation_list()— rebuilt for the new column

  Why the unique constraint goes:
    A unique handle is a namespace, and a namespace is enumerable. Display
    names are allowed to collide; that is what stops them being addresses.

  Why this is split out of 0022_no_directory:
    The directory itself (search_profiles, and the connect-code flow that
    replaces it) cannot go until Plan 3 Task 5 ships QR and short-code
    connection — dropping it first leaves two accounts with no way to find
    each other. But the profile schema is what every signup writes through,
    and it is being changed while there are no accounts to migrate. Doing the
    rename now means every account created from here on lands on the final
    shape; doing it later would mean migrating real users for no reason.

  Function bodies do not follow a RENAME:
    Postgres stores function bodies as text, so ALTER TABLE ... RENAME COLUMN
    does not rewrite them. Three live functions reference profiles.username.
    handle_new_user() is the signup trigger — left alone it breaks EVERY new
    signup the moment this migration applies. All three are rebuilt below.
*/

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_key;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS username_format;
ALTER TABLE public.profiles RENAME COLUMN username TO display_name;

-- ---------------------------------------------------------------------------
-- 2. The signup trigger.
--
-- No lower(): a display name is shown as the person typed it. The metadata key
-- stays `username` so an older client mid-upgrade still signs up successfully;
-- the client sends `display_name` from Task 6 onward and both are read here.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. The directory, on borrowed time.
--
-- Kept working only until Task 5's connect flow exists, then dropped entirely.
-- The needle charset now admits spaces and the comparison is case-folded,
-- because display names may contain both and a search that cannot find them
-- would be a regression shipped in the name of a feature that is leaving.
--
-- left(...) = needle rather than LIKE is retained deliberately: LIKE treats
-- '_' as a wildcard, and search_profiles('___') would otherwise dump the
-- directory this function exists to ration.
-- ---------------------------------------------------------------------------
-- Dropped first: CREATE OR REPLACE cannot rename an OUT column, and this
-- function's result column goes from username to display_name.
DROP FUNCTION IF EXISTS public.search_profiles(text);
CREATE FUNCTION public.search_profiles(prefix text)
RETURNS TABLE(id uuid, display_name text, avatar_url text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  needle text := lower(btrim(coalesce(prefix, '')));
BEGIN
  IF length(needle) < 3 OR needle !~ '^[a-z0-9_ ]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, p.avatar_url
  FROM public.profiles p
  WHERE lower(left(p.display_name, length(needle))) = needle
    AND p.id <> (select auth.uid())
  ORDER BY p.display_name
  LIMIT 10;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The sidebar. Body copied from 0017_self_chat.sql with the column renamed;
--    0023 rebuilds it again to remove last_message.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.conversation_list();
CREATE FUNCTION public.conversation_list()
RETURNS TABLE(
  peer_id uuid,
  display_name text,
  avatar_url text,
  last_message text,
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
         pr.display_name,
         pr.avatar_url,
         l.last_message,
         l.last_media_type,
         l.last_sender_id,
         l.last_at,
         pr.last_seen_at
  FROM latest l
  JOIN public.profiles pr ON pr.id = l.peer_id;
$$;
