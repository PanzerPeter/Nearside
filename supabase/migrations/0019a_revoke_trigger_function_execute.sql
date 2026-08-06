/*
  Nearside — revoke client EXECUTE on trigger functions

  Contents:
    1. notify_push_on_message  — EXECUTE revoked from PUBLIC, anon, authenticated
    2. set_updated_at          — EXECUTE revoked from PUBLIC, anon, authenticated

  Why:
    Both are trigger functions, and PostgREST exposes every executable function
    in `public` at /rest/v1/rpc/<name>. Neither is meant to be called that way.
    0014 and 0001 created them without the REVOKE that every other trigger
    function in this schema carries — enforce_message_rate (0009),
    messages_prevent_reassign (0005), handle_new_user (0001, 0019) — so this
    closes the gap rather than introducing a new convention.

    Surfaced by Supabase's database linter as
    `anon_security_definer_function_executable` against
    notify_push_on_message, which is SECURITY DEFINER and therefore the more
    serious of the two. set_updated_at is SECURITY INVOKER and is included
    because it is the same mistake with a smaller blast radius.

  Not exploitable today: Postgres refuses to run a trigger function outside a
  trigger context, so an RPC call errors out. This is surface reduction, not an
  incident fix.

  Numbered 0019a rather than 0020 on purpose: Plan 2 ships 0020_identity_keys,
  and lexical ordering already puts 0019 < 0019a < 0020.

  Deliberately NOT touched: public.rls_auto_enable(), which the linter flags
  for the same reason. It backs the `ensure_rls` event trigger, is owned by
  postgres, and appears in no migration in this repository — it is platform
  configuration, not ours to revoke here.
*/

REVOKE EXECUTE ON FUNCTION public.notify_push_on_message() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
