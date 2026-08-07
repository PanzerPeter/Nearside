/*
  Nearside — no directory

  Contents:
    1. search_profiles()   — dropped. This is the whole point.
    2. connect_tokens      — short-lived, single-use codes
    3. mint/redeem RPCs    — SECURITY DEFINER, the only reachable surface

  Why this is 0022b and not 0022:
    0022_display_name.sql took the profile-schema half of this migration and
    applied it early, while the database still held no accounts to migrate —
    username renamed to display_name, its UNIQUE and format constraints
    dropped, and handle_new_user(), search_profiles() and conversation_list()
    all rebuilt for the new column. What was left is the directory removal
    itself, which is this file.

  Applied out of numeric order, deliberately:
    This file is numbered 0022b but applies AFTER 0023, 0024 and 0025, because
    it may not run until the connect flow that replaces the directory works on
    a device. The number records authorship order; the plan records apply
    order.

  Security notes:
    - connect_tokens has no RLS policy at all, exactly like the invite_codes
      table it descends from. It is reachable only through the two functions
      below, which are REVOKEd from anon.
    - redeem_connect_code returns the minting user's id and marks the token
      spent in one statement, so two people cannot redeem the same code.
    - Tokens expire in 10 minutes. A code read off someone's screen an hour
      later is worthless.
*/

DROP FUNCTION IF EXISTS public.search_profiles(text);

CREATE TABLE IF NOT EXISTS public.connect_tokens (
  code       text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.connect_tokens ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.mint_connect_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Crockford-style: no O, no I, no L, no U, no 0/1. These codes are read
  -- aloud down a phone line and typed by hand, so the alphabet is chosen for
  -- the ear and the thumb, not for density. 30^8 is ~6.5e11 -- ample for a
  -- token that dies in ten minutes.
  alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  new_code text;
  raw      bytea;
  attempt  int := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  DELETE FROM public.connect_tokens WHERE user_id = auth.uid() AND used_at IS NULL;

  -- Retry on the astronomically unlikely primary-key collision rather than
  -- letting it surface as a raw 23505 to someone trying to add a friend.
  LOOP
    -- gen_random_bytes, not random(): random() is a session-seeded PRNG, and a
    -- predictable connect code is an invitation an attacker can redeem before
    -- its owner does. The modulo bias across 30 symbols is a fraction of a bit
    -- and irrelevant for a single-use token with a ten-minute life.
    -- Schema-qualified: pgcrypto is installed in `extensions` on this project,
    -- and SET search_path = '' means an unqualified call does not resolve.
    raw := extensions.gen_random_bytes(8);
    new_code := '';
    FOR i IN 0..7 LOOP
      new_code := new_code || substr(alphabet, 1 + (get_byte(raw, i) % length(alphabet)), 1);
    END LOOP;

    BEGIN
      INSERT INTO public.connect_tokens (code, user_id, expires_at)
      VALUES (new_code, auth.uid(), now() + interval '10 minutes');
      RETURN new_code;
    EXCEPTION WHEN unique_violation THEN
      attempt := attempt + 1;
      IF attempt >= 5 THEN RAISE EXCEPTION 'code_mint_failed'; END IF;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.redeem_connect_code(code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  UPDATE public.connect_tokens t
     SET used_at = now(), used_by = auth.uid()
   WHERE t.code = upper(redeem_connect_code.code)
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND t.user_id <> auth.uid()
  RETURNING t.user_id INTO owner;

  IF owner IS NULL THEN RAISE EXCEPTION 'code_invalid'; END IF;
  RETURN owner;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_connect_code() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_connect_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mint_connect_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_connect_code(text) TO authenticated;

/*
  Verify, because the failure mode here is silence:

    select public.search_profiles('a');   -- expect: function does not exist
    select p.proname from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ilike '%username%';   -- expect zero rows
*/
