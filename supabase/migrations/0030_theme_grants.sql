/*
  Nearside — theme grants

  Applied after 0029. Depends on 0001 (profiles) and on nothing applied after
  it. Safe to re-run: every statement is idempotent.

  What this is for:
    A theme pack is normally owned because it was bought, and RevenueCat is the
    only record of that. There is no way to hand a pack to an account for a
    demo, a review build, a press screenshot or a refund gesture without either
    charging for it or shipping a debug switch in the client. This table is the
    server-side answer: a row here is a pack the account owns, merged with the
    entitlements at read time by `src/lib/theme-grants.ts`.

  Why there is no INSERT policy:
    A grant that the client could write is not a grant — it is a free unlock
    for anyone who can read the network tab, and the six packs are the only
    revenue this product has. Rows arrive from the SQL editor (the `postgres`
    role) or from a service-role key. `authenticated` may read its own rows and
    nothing else, so the app can see what it owns and cannot award it.

  Why the pack ids are repeated here:
    `grant_theme_packs()` takes NULL to mean "all of them", which means this
    file has to know the list, which means it can drift from `PACKS` in
    `src/lib/purchases.ts`. `theme-grants.test.ts` reads this file and fails if
    a pack in the client is missing from the array below.

  To give a test account every pack (SQL editor, as postgres):

    SELECT public.grant_theme_packs('tester@example.com');

  To take them back:

    SELECT public.revoke_theme_grants('tester@example.com');
*/

-- 1. The table ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.theme_grants (
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pack_id    text NOT NULL,
  -- Why this account has it: 'showcase', 'review build', 'refund'. Read by a
  -- human six months from now who is deciding whether it can be removed.
  note       text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pack_id)
);

ALTER TABLE public.theme_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS theme_grants_select_own ON public.theme_grants;
CREATE POLICY theme_grants_select_own ON public.theme_grants
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT, UPDATE or DELETE policy, and the grants below match: RLS alone
-- would already refuse the write, but revoking the privilege means a policy
-- added carelessly later cannot quietly open the till.
REVOKE ALL ON public.theme_grants FROM anon;
REVOKE ALL ON public.theme_grants FROM authenticated;
GRANT SELECT ON public.theme_grants TO authenticated;

-- 2. Granting ----------------------------------------------------------------

/*
  The packs the client knows about. Must match `PACKS` in
  `src/lib/purchases.ts`; a test enforces it in that direction.
*/
CREATE OR REPLACE FUNCTION public.all_theme_packs()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'pack.midnight',
    'pack.paper',
    'pack.terminal',
    'pack.sunset',
    'pack.sakura',
    'pack.graphite'
  ]::text[];
$$;

/*
  Give an account packs by email. NULL pack ids means all of them.

  SECURITY DEFINER because auth.users is not readable by anyone else, and the
  email is the only handle a human running this actually has. That makes the
  EXECUTE grant the whole security story, which is why it is revoked from every
  role below — including `authenticated`, which would otherwise be able to
  award itself the entire catalogue with one RPC call.
*/
CREATE OR REPLACE FUNCTION public.grant_theme_packs(
  p_email    text,
  p_pack_ids text[] DEFAULT NULL,
  p_note     text DEFAULT 'showcase'
)
RETURNS TABLE (pack_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
-- The RETURNS TABLE column is itself a plpgsql variable named pack_id, which
-- makes the ON CONFLICT target below ambiguous and the function fail at call
-- time rather than at creation. Column wins.
#variable_conflict use_column
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no account with email %', p_email;
  END IF;
  -- The foreign key would say this too, but as a constraint violation naming a
  -- uuid nobody typed. An account can exist without a profile row between
  -- signup and the trigger that creates one.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'account % has no profile row yet', p_email;
  END IF;

  RETURN QUERY
  INSERT INTO public.theme_grants AS g (user_id, pack_id, note)
  SELECT v_user_id, p.id, p_note
    FROM unnest(COALESCE(p_pack_ids, public.all_theme_packs())) AS p(id)
  ON CONFLICT (user_id, pack_id) DO UPDATE SET note = EXCLUDED.note
  RETURNING g.pack_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_theme_grants(
  p_email    text,
  p_pack_ids text[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_removed integer;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE lower(email) = lower(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'no account with email %', p_email;
  END IF;

  DELETE FROM public.theme_grants
   WHERE user_id = v_user_id
     AND (p_pack_ids IS NULL OR pack_id = ANY (p_pack_ids));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.all_theme_packs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_theme_packs(text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_theme_grants(text, text[]) FROM PUBLIC, anon, authenticated;
