/*
  Nearside — three things the server was keeping for nobody

  Applied after 0041. Nothing here changes what the app can do; each item is a
  record the database held that no code has ever read back.

  1. `connect_tokens.used_by`

     `redeem_connect_code` wrote it and nothing has ever selected it. Single-use
     is enforced by `used_at IS NULL`, not by knowing who the somebody was — so
     the column was a standing list of who added whom, and at what minute,
     living beside a table (`friendships`) that already records the connection
     without the timestamp. A record nobody reads is a record kept only for
     whoever eventually asks for it.

  2. Spent and expired tokens

     `mint_connect_code` deletes the caller's *unused* tokens when it issues a
     new one, so a redeemed code stayed forever. The sweep in the minute-by-
     minute expiry job now takes them, but only once `expires_at` has passed:
     deleting a used code inside its ten minutes would free the code string to
     be minted and redeemed a second time, and single-use is the whole security
     property of a connect code. Past expiry `redeem_connect_code` already
     refuses it, so the row is proof of nothing anybody can use.

  3. `pg_trgm`

     Installed for the trigram index on `messages.content`. 0023 dropped the
     index and the column with it; the extension has been sitting in the
     database since as a decoration whose name suggests the server searches
     message text. It does not, and cannot.

  Each is reversible by re-adding a column or an extension. None of them can be
  reversed for the data already in them, which is the point.
*/

ALTER TABLE public.connect_tokens
  DROP COLUMN IF EXISTS used_by;

-- Rewritten to take spent codes with it. The function is the whole job — there
-- is one cron entry (`nearside-expire`) and adding a second for eight words of
-- DELETE would be a second thing to remember to schedule on a fresh project.
CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed text[];
BEGIN
  SELECT coalesce(array_agg(media_path), '{}')
    INTO doomed
    FROM (
      SELECT media_path FROM public.messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
      UNION ALL
      SELECT media_path FROM public.room_messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
    ) expiring;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Spent and expired connect codes (0042). Expiry, not tidying: a token past
  -- `expires_at` is one `redeem_connect_code` already refuses, so nothing is
  -- taken away. Used codes are reachable only through this condition, which is
  -- what stops a redeemed code being minted again while it is still live.
  DELETE FROM public.connect_tokens WHERE expires_at < now();

  -- Best effort. The rows above held the only copies of these files' keys, so
  -- the bytes are already unopenable; this reclaims the listing.
  IF array_length(doomed, 1) > 0 THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

-- `redeem_connect_code` wrote `used_by` on every redemption. plpgsql resolves
-- column names when the statement first runs, not when the function is
-- created, so dropping the column above without this leaves a function that
-- looks fine and raises 42703 at the moment somebody tries to add a friend.
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
     SET used_at = now()
   WHERE t.code = upper(redeem_connect_code.code)
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND t.user_id <> auth.uid()
  RETURNING t.user_id INTO owner;

  IF owner IS NULL THEN RAISE EXCEPTION 'code_invalid'; END IF;
  RETURN owner;
END;
$$;

-- Nothing has referenced it since 0023. CASCADE is deliberately not used: if
-- some object still depends on it, this should fail loudly rather than take
-- that object with it.
DROP EXTENSION IF EXISTS pg_trgm;
