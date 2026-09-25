/*
  Nearside — the expiry sweep, past the platform's storage delete guard

  Applied after 0053. No new table, column, policy or grant: one function,
  replaced whole.

  Supabase added `storage.protect_delete()`, a statement trigger on
  `storage.objects` that raises unless the transaction-local setting
  `storage.allow_delete_query` is 'true'. The Storage API sets that flag for
  itself; `expire_messages()` deletes the expired rows' objects in SQL and
  did not. So from the moment the guard arrived, every sweep that had an
  expired attachment to collect raised 42501 — and the raise rolled back the
  whole call, the message deletes and the connect-token deletes with it. The
  same doomed rows were found again a minute later and failed again: sixty
  errors an hour in the Postgres log, and disappearing messages that did not
  disappear from the server.

  The fix is the flag, set immediately before the one statement that needs
  it. `set_config(..., true)` is local to the transaction pg_cron opens for
  the call, so it opens nothing beyond this function. Rows that expired while
  the sweep was failing are still there and still past `expires_at`; the
  first run after this migration collects all of them. The thread already
  drops a row past its `expires_at` (`dropExpired`), so nothing was shown
  that should not have been — the leftover was on the server.

  verify/platform-shim.sql now installs the same guard, which is how this
  would have been caught: the smoke test calls the sweep, and the shim had a
  storage.objects without the trigger the live project has.
*/

CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed text[];
BEGIN
  -- Both objects per row (0051). `unnest` rather than four UNION branches, so
  -- the pair stays written once per table and a third object — if one is ever
  -- added — is one more element rather than one more branch.
  SELECT coalesce(array_agg(path), '{}')
    INTO doomed
    FROM (
      SELECT unnest(ARRAY[media_path, media_thumb_path]) AS path
        FROM public.messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
      UNION ALL
      SELECT unnest(ARRAY[media_path, media_thumb_path])
        FROM public.room_messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
    ) expiring
   -- Null on a voice note and on every row written before 0044.
   WHERE expiring.path IS NOT NULL;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Spent and expired connect codes (0042). Expiry, not tidying: a token past
  -- `expires_at` is one `redeem_connect_code` already refuses, so nothing is
  -- taken away. Used codes are reachable only through this condition, which is
  -- what stops a redeemed code being minted again while it is still live.
  DELETE FROM public.connect_tokens WHERE expires_at < now();

  -- Best effort. The rows above held the only copies of these files' keys, so
  -- the bytes are already unopenable; this reclaims the listing.
  --
  -- The flag is what the Storage API sets for itself (0054). Without it the
  -- platform's `protect_delete` trigger raises, and the raise rolls back every
  -- delete above: expired messages stayed on the server, retried every minute.
  -- Transaction-local, so it opens nothing beyond this call.
  IF array_length(doomed, 1) > 0 THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;
