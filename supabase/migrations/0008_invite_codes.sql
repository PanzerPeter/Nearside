/*
  Chatly — invite-gated signup & profile lockdown
  Run once in the Supabase SQL editor after 0007.

  Contents:
    1. invite_codes        — single-use registration codes
    2. handle_new_user     — replaced: now consumes a valid code or aborts
    3. profiles SELECT     — narrowed from "every authenticated user" to
                             "myself, my friends, and anyone with a pending
                             request either way"
    4. search_profiles()   — the only way to discover a stranger, by prefix

  Why:
    The old profiles_select_all policy let any account read the entire user
    table, and the client search ran an unanchored ILIKE over it — a full
    directory dump for anyone who signed up. Registration was open, so that
    was anyone at all. Gating signup removes the attacker; narrowing SELECT
    removes the capability.

  Security notes:
    - handle_new_user stays SECURITY DEFINER (it must write public.profiles
      from an auth.users trigger) and is REVOKEd from all client roles.
    - It raises on a missing/spent code, which aborts the auth.users INSERT,
      so no orphan account survives a bad code.
    - search_profiles is SECURITY DEFINER because it deliberately reads past
      the narrowed SELECT policy. It is constrained instead by a minimum
      prefix length and a hard row cap, and it never returns the caller.
*/

-- ============================================================
-- 1. invite_codes
-- ============================================================
CREATE TABLE IF NOT EXISTS public.invite_codes (
  code       text PRIMARY KEY,
  note       text,
  -- References auth.users, not public.profiles: a profile can be deleted
  -- (e.g. self-service account deletion) without recycling the code back
  -- into the unused pool, and without leaving used_at set while used_by
  -- goes NULL. auth.users already has the row when handle_new_user fires
  -- (it's an AFTER INSERT trigger on that table), so this doesn't
  -- reintroduce the ordering problem below.
  used_by    uuid REFERENCES auth.users(id),
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_format CHECK (code ~ '^[A-Za-z0-9_-]{6,64}$')
);

ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the SECURITY DEFINER signup trigger touches
-- this table. A client that could read it could enumerate valid codes.

-- Belt-and-suspenders: Supabase's default grants give anon/authenticated
-- table-level access, so RLS-with-no-policies is only safe as long as
-- nobody later adds a permissive policy by mistake. Revoking the grant
-- outright makes the lockdown structural instead of incidental — a stray
-- policy alone wouldn't be enough to expose this table.
REVOKE ALL ON public.invite_codes FROM anon, authenticated;

-- ============================================================
-- 2. handle_new_user — now validates an invite code
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  supplied text := NEW.raw_user_meta_data->>'invite_code';
  claimed  text;
BEGIN
  IF supplied IS NULL OR btrim(supplied) = '' THEN
    RAISE EXCEPTION 'invite_required';
  END IF;

  -- The profile row must exist before the claim below: used_by references
  -- auth.users now (see table def), but if it still referenced
  -- public.profiles this order would be load-bearing — the FK is
  -- non-deferrable and checked at end-of-statement, so claiming first
  -- against a not-yet-inserted profile would fail every signup. Keep the
  -- insert first regardless, since it's the correct causal order anyway.
  INSERT INTO public.profiles (id, username)
  VALUES (NEW.id, lower(NEW.raw_user_meta_data->>'username'));

  -- Claim atomically: the UPDATE ... RETURNING both checks and spends the
  -- code in one statement, so two simultaneous signups cannot share it.
  -- Same transaction as the insert above, so a failure here (or below)
  -- still rolls back the profile too.
  UPDATE public.invite_codes
     SET used_by = NEW.id, used_at = now()
   WHERE code = btrim(supplied)
     AND used_by IS NULL
  RETURNING code INTO claimed;

  IF claimed IS NULL THEN
    RAISE EXCEPTION 'invite_invalid';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM public, anon, authenticated;

-- ============================================================
-- 3. Narrow the profiles SELECT policy
-- ============================================================
DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_connected" ON public.profiles;
CREATE POLICY "profiles_select_connected" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE (f.requester_id = (select auth.uid()) AND f.addressee_id = profiles.id)
         OR (f.addressee_id = (select auth.uid()) AND f.requester_id = profiles.id)
    )
  );

-- ============================================================
-- 4. search_profiles — prefix-only stranger discovery
-- ============================================================
CREATE OR REPLACE FUNCTION public.search_profiles(prefix text)
RETURNS TABLE (id uuid, username text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  needle text := lower(btrim(coalesce(prefix, '')));
BEGIN
  -- Prefix-anchoring plus the LIMIT below raises the cost of enumeration —
  -- it does not prevent it. A determined caller with a valid account can
  -- still walk the namespace call by call. The real perimeter is
  -- invite-gated signup: every caller reaching this function is already
  -- vouched for, so what's left here is friction, not a security boundary.
  IF length(needle) < 3 OR needle !~ '^[a-z0-9_]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.username, p.avatar_url
  FROM public.profiles p
  -- left(...) = needle, not `LIKE needle || '%'`: LIKE treats '_' as a
  -- single-character wildcard, and the charset above allows '_'. With LIKE,
  -- search_profiles('___') would match every 3+ char username — exactly the
  -- directory dump this function exists to prevent. left() is a literal
  -- comparison with no wildcard semantics.
  WHERE left(p.username, length(needle)) = needle
    AND p.id <> (select auth.uid())
  ORDER BY p.username
  LIMIT 10;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.search_profiles(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_profiles(text) TO authenticated;
