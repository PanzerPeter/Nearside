/*
  Nearside — open signup
  Run once in the Supabase SQL editor after 0018.

  Contents:
    1. handle_new_user  — replaced: no longer consumes an invite code
    2. invite_codes     — dropped

  Why:
    0008 gated registration on a single-use code, which was the right answer
    for a private chat among friends and the wrong one for a Play listing:
    twelve closed-testing accounts would each need a hand-minted row.

    The capability 0008 was actually defending against — a full directory
    dump via search_profiles() — is removed separately in 0022, because it is
    still the only way two people can connect until the QR and short-code
    flow replaces it.

  Security notes:
    - handle_new_user stays SECURITY DEFINER (it writes public.profiles from
      an auth.users trigger) and stays REVOKEd from all client roles.
    - The narrowed profiles SELECT policy from 0008 is deliberately NOT
      relaxed. Open registration without it would restore the directory dump.
*/

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

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TABLE IF EXISTS public.invite_codes;
