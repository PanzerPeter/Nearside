/*
  Chatly — consolidated initial schema
  Run once in the Supabase SQL editor of a fresh project.

  Contents:
    1. profiles         — usernames + avatars (1:1 with auth.users)
    2. friendships      — friend requests / connections
    3. messages         — 1:1 direct messages with optional media, edit & soft-delete
    4. handle_new_user  — trigger that seeds a profile row from signup metadata
    5. Realtime         — messages added to the realtime publication

  !! PARTLY SUPERSEDED BY 0008 — READ BEFORE RE-RUNNING !!
    0008 narrows profile SELECT and rewrites handle_new_user to enforce the
    invite gate. The open `profiles_select_all` policy this file used to create
    has been removed from it (see below), but `handle_new_user` here is still
    the PRE-INVITE version and is created with CREATE OR REPLACE — so re-running
    this file reopens signup to anyone. If you re-run it, re-run 0008 straight
    after, in the same sitting.

  Security notes:
    - RLS enabled on every table; policies scope rows to the owner / participants.
    - All UPDATE policies include USING + WITH CHECK.
    - Signup metadata (raw_user_meta_data) is used ONLY to seed the profile row,
      never for authorization decisions.
*/

-- ============================================================
-- 1. profiles
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   text UNIQUE NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_]{3,24}$')
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- SUPERSEDED BY 0008. This file originally created a `profiles_select_all`
-- policy with USING (true), letting any authenticated user read the whole
-- profile directory. 0008 replaced it with `profiles_select_connected`.
-- Postgres ORs permissive policies together, so re-creating the open one here
-- would silently restore full-directory reads alongside the narrow policy —
-- the DROP stays, the CREATE is deliberately gone. A window with no SELECT
-- policy fails closed, which is the correct direction to fail.
DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE TO authenticated USING ((select auth.uid()) = id);

-- keep updated_at fresh
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 2. friendships
-- ============================================================
CREATE TABLE IF NOT EXISTS public.friendships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id),
  CONSTRAINT no_self_friend CHECK (requester_id <> addressee_id)
);

-- Covering index for the addressee_id FK (pending-requests lookup).
CREATE INDEX IF NOT EXISTS friendships_addressee_idx
  ON public.friendships (addressee_id);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friendships_select_own" ON public.friendships;
CREATE POLICY "friendships_select_own" ON public.friendships
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (requester_id, addressee_id));

DROP POLICY IF EXISTS "friendships_insert_own" ON public.friendships;
CREATE POLICY "friendships_insert_own" ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = requester_id);

DROP POLICY IF EXISTS "friendships_update_addressee" ON public.friendships;
CREATE POLICY "friendships_update_addressee" ON public.friendships
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = addressee_id)
  WITH CHECK ((select auth.uid()) = addressee_id);

DROP POLICY IF EXISTS "friendships_delete_own" ON public.friendships;
CREATE POLICY "friendships_delete_own" ON public.friendships
  FOR DELETE TO authenticated
  USING ((select auth.uid()) IN (requester_id, addressee_id));

-- ============================================================
-- 3. messages
-- ============================================================
CREATE TABLE IF NOT EXISTS public.messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content     text,
  media_path  text,
  media_type  text CHECK (media_type IN ('image', 'video')),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_length CHECK (content IS NULL OR char_length(content) <= 2000),
  CONSTRAINT has_body CHECK (content IS NOT NULL OR media_path IS NOT NULL),
  CONSTRAINT media_pair CHECK ((media_path IS NULL) = (media_type IS NULL))
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON public.messages (user_id, receiver_id, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_rev_idx
  ON public.messages (receiver_id, user_id, created_at);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select_participant" ON public.messages;
CREATE POLICY "messages_select_participant" ON public.messages
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_id, receiver_id));

DROP POLICY IF EXISTS "messages_insert_sender" ON public.messages;
CREATE POLICY "messages_insert_sender" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND receiver_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = (select auth.uid()) AND f.addressee_id = receiver_id)
          OR (f.requester_id = receiver_id AND f.addressee_id = (select auth.uid()))
        )
    )
  );

-- sender can edit / soft-delete their own messages
DROP POLICY IF EXISTS "messages_update_sender" ON public.messages;
CREATE POLICY "messages_update_sender" ON public.messages
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "messages_delete_sender" ON public.messages;
CREATE POLICY "messages_delete_sender" ON public.messages
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================================
-- 4. handle_new_user — seed profile from signup metadata
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, lower(NEW.raw_user_meta_data->>'username'));
  RETURN NEW;
END;
$$;

-- Trigger functions run in the context of the triggering statement, so the
-- function does not need to be directly executable by client roles. Revoke to
-- avoid exposing a SECURITY DEFINER function as a public endpoint.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 5. Realtime — stream message inserts & updates to clients
-- ============================================================
-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS: a second run raises
-- 42710 and aborts the script. Being the last statement in the file, that abort
-- makes a re-run look like it did nothing when in fact everything above it
-- already committed. Guard it, same as 0006 does.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END;
$$;
