# The live project

What is actually deployed, as against [`README.md`](README.md) (what the folder
is) and [`migrations/README.md`](migrations/README.md) (what each file does).
The project ref is deliberately not written down here: it is the API host, it is
not rotatable, and a public repo is no place to hand out a target for free. It
lives in `.env` and in `supabase/.temp/`, both gitignored.

Anything below that says "confirm with" is a claim this file cannot keep true on
its own. Run the query before trusting it.

## Migrations

`0001`–`0030` and `0032`, in the order given by
[`migrations/apply-order.txt`](migrations/apply-order.txt), are live. `0031` is
the one gap, described below.

`0001`–`0019a` were replayed onto this project during Plan 1; `0020` onward were
applied individually and are the ones the platform's migration history records.

`0032_sealed_exchange.sql` is applied. It adds `sealed_answers`,
`messages.sealed_prompt`, the `has_answered()` helper the SELECT policy needs,
and the `ask_sealed()` RPC. Confirm with:

```sql
SELECT to_regclass('public.sealed_answers') IS NOT NULL AS table_live,
       (SELECT count(*) FROM pg_policies WHERE tablename = 'sealed_answers') AS policies;
```

Two policies, SELECT and INSERT. There is deliberately no UPDATE policy and no
UPDATE grant — an editable answer would defeat the protocol.

**`0031_grant_hygiene.sql` is not applied.** It is two corrections found by
replaying the folder into a throwaway Postgres (`npm run db:verify`), neither
reachable from the app:

- `conversation_list()` is executable by `anon`. `0022` revoked it; `0023`
  rebuilt the function with `DROP FUNCTION` — required, because removing
  `last_message` changes the return type — and the new one was created without
  a REVOKE, so the default `EXECUTE TO PUBLIC` came back. Not a disclosure: with
  no JWT `auth.uid()` is NULL, `peers` is empty and the join to `profiles`
  matches nothing, so an anonymous call returns zero rows. It is an unintended
  endpoint at `/rest/v1/rpc/conversation_list`, which is the class `0019a`
  exists to close.
- `chat_backgrounds`'s primary key is named `chat_backgrounds_pkey1`, because
  `0013` renamed the pair-shaped table aside before creating the new one beside
  it. Cosmetic, and the one place a database built from `schema.sql` would
  legitimately differ from a replay of this folder.

Confirm the first before and after applying it:

```sql
SELECT has_function_privilege('anon', 'public.conversation_list()', 'EXECUTE')
       AS should_be_false;
```

### `0029_disappearing.sql` — applied, plus two things the file cannot do

1. **The `pg_cron` extension** (1.6.4, in `pg_catalog`). The file's functions do
   not depend on it, but the sweep never runs without it.
2. **A one-off `cron.schedule` call**, quoted at the bottom of the file and
   deliberately left out of its body — it fails with a duplicate-jobname error
   if re-run, which would make the rest of the file unsafe to re-run.

Job `nearside-expire`, `* * * * *`, active. Confirm with:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'nearside-expire';
SELECT status, return_message, start_time FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'nearside-expire')
 ORDER BY start_time DESC LIMIT 5;
```

Without it the columns and triggers exist and stamp `expires_at` correctly, and
nothing is ever deleted — which is the failure mode that looks like the feature
working.

### `0030_theme_grants.sql` — applied, no rows

Lets a demo or review account own theme packs nobody paid for. Nothing else
depends on it: without the table the client's grant read fails and every account
falls back to whatever RevenueCat says it owns, which is the behaviour that
shipped. Idempotent and safe to re-run as `postgres`. Per account:

```sql
SELECT public.grant_theme_packs('tester@example.com');   -- all six packs
SELECT public.revoke_theme_grants('tester@example.com'); -- take them back
```

Both are `SECURITY DEFINER` and revoked from `authenticated` and `anon` — they
read `auth.users` by email, and a client that could call them would be able to
award itself the entire catalogue. Confirm the lockdown survived a later
migration with:

```sql
SELECT has_function_privilege('authenticated',
         'public.grant_theme_packs(text, text[], text)', 'EXECUTE') AS should_be_false;
```

## What the server holds

After `0023` there is no message body in Postgres. `messages` carries a
ciphertext and a nonce and nothing readable; previews and search run against the
device's local SQLite mirror instead (`src/lib/localdb.ts`), one database file
per account. Media objects are sealed before upload and the file key travels
sealed in the message row, so Storage holds bytes it cannot interpret either.

Two consequences that look like bugs and are not:

- A conversation is only searchable on a device that has actually loaded it.
  Nothing else can decrypt it.
- Attachments sent before `0024` have null key columns and render as
  unavailable.

## Auth configuration (dashboard)

**Authentication → URL Configuration.** Emailed links (password reset, email
confirmation) redirect to `app.nearside://auth/…` on the device — see
`src/lib/authRedirect.ts`. There is no hosted web origin; the browser build is a
development convenience. Allow-list:

- `app.nearside://auth/*` — the device path, and the one that matters
- `http://localhost:5173` — `npm run dev`

**Authentication → Providers → Email → Confirm email.** On by default; the app
handles it ("check your email"), and the profile row is created immediately by
the signup trigger either way.

Still open, both dashboard-only:

- **Custom SMTP.** The built-in sender is rate-limited and not for production.
- **Leaked-password protection.** Off — the security advisor flags it.

## Signup

Open since `0019`. `handle_new_user()` reads the display name from the signup
metadata, preferring `display_name` and falling back to `username` so a client
mid-upgrade still works. Names are not unique and have no format constraint —
people are found by connect code, not by name.

Always create users through the app; the trigger needs that metadata.

## Storage

[`storage/setup.sql`](storage/setup.sql) creates both buckets and their
policies. Run it once, after the schema.

- `avatars` — public, 5 MB, image types. Avatars are not sealed.
- `chat-media` — private, 50 MB, `application/octet-stream` plus image types.
  Attachments go up sealed as octet-stream; the image types are there because
  chat backgrounds share this bucket and are not sealed.

Policies key `chat-media` off the conversation folder
(`{sortedUidA}_{sortedUidB}/`), so only the two participants can read or write.

The mime list appears both here and in `0025_sealed_media_mime.sql`, which used
to be a standing invitation to edit one and not the other. `npm run db:verify`
now applies the setup script down both paths and compares the resulting bucket
rows, so that drift fails instead of shipping.

## Edge functions

**Deployment state is not recorded here, because this file cannot keep it true.**
`list_edge_functions` returned an empty list the last time it was checked, and
the call functions are newer than that check. Confirm before trusting anything
below:

```bash
supabase functions list --project-ref "$SUPABASE_PROJECT_REF"
```

Everything in `supabase/functions/` is source until deployed. `verify_jwt` for
each is declared in [`config.toml`](config.toml).

- **`delete-account`** — needed. Settings → Danger zone calls it, and the call
  fails until it is deployed. It resolves the caller from their JWT, removes
  their `avatars/{uid}/` objects and every `chat-media` conversation folder they
  participate in, then deletes the `auth.users` row (cascading messages,
  friendships, reactions, receipts and room membership through `profiles.id`).
  Storage is cleared before the auth user, because the paths are derived from
  ids that disappear with the account; a failure after that point leaves the
  account intact and the call safe to retry.

  ```bash
  supabase functions deploy delete-account --project-ref "$SUPABASE_PROJECT_REF"
  ```

  Needs no secrets — `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` are injected by the Edge runtime. Test it with a
  throwaway account: there is no undo and no backup.

- **`call-ring`** — needed for calls to reach a phone that is not already
  showing the app. It resolves the caller from their JWT, checks the two are
  friends, and sends a OneSignal push carrying a caller id, a display name, a
  call id and `voice`/`video` — nothing else, because there is nothing else about
  a call the server holds. `CallNotificationExtension` intercepts it on the
  device and raises a full-screen ring in its place.

  ```bash
  supabase functions deploy call-ring --project-ref "$SUPABASE_PROJECT_REF"
  ```

  Shares `ONESIGNAL_APP_ID` and `ONESIGNAL_REST_API_KEY` with `send-push`.
  Without it a call still rings a friend who has the app open — the offer goes
  over the realtime topic either way — and reaches nobody else.

- **`call-ice`** — needed for calls behind carrier-grade NAT, which on mobile
  networks is most of them. It mints Cloudflare TURN credentials against the
  caller's JWT, one set per call and good for an hour, inside a monthly egress
  budget it checks before minting (default 900 GB, under the free 1,000). The
  client falls back to STUN alone when this is unreachable, so a missing
  deployment is calls that mostly work and sometimes never connect — the worst
  failure mode there is to debug.

  ```bash
  supabase functions deploy call-ice --project-ref "$SUPABASE_PROJECT_REF"
  supabase secrets set CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=...
  ```

  Optional beside those: `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_ANALYTICS_API_TOKEN` for the relayed-bytes check, and
  `TURN_MONTHLY_BUDGET_GB` to stop minting credentials past a spend cap. The
  API token is server-side only — a long-lived TURN secret in the bundle is a
  free relay for anyone who unzips the APK.

- **`send-push`** — the Web Push transport, superseded by OneSignal and
  probably not worth deploying. `0028` dropped `push_subscriptions` and the
  client-side VAPID code is gone, so the only caller left is `0014`'s database
  trigger. That trigger is applied but inert: `push_config` is empty, so it
  returns immediately. Turning it on means deploying with `--no-verify-jwt`,
  setting `PUSH_TRIGGER_SECRET`, and inserting a `push_config` row pointing at
  the function URL with the same secret — in that order.

## Security advisors — current state

- **`message_pushes` and `push_config` have RLS enabled with no policies**
  (INFO). Intentional: both are server-side, reached only by the service role
  and the trigger. No policy is the lockdown, because RLS with no policy fails
  closed.
- **`connect_tokens` likewise.** Reachable only through `mint_connect_code()`
  and `redeem_connect_code()`, which are `SECURITY DEFINER` and revoked from
  `anon`. A client that could read the table could enumerate live codes.
- **`pg_trgm` and `pg_net` live in `public`** (WARN) — where `0010` and `0014`
  put them. `pg_trgm` is now unused: `0023` dropped both the trigram index and
  the column it covered. It is kept because moving an extension between schemas
  on a live project is not worth the risk of the move failing halfway.
- **`SECURITY DEFINER` functions callable by `authenticated`** (WARN):
  `redeem_connect_code`, `mint_connect_code`, `rooms_for_me`, `is_room_member`,
  `is_room_owner`, `set_conversation_timer`, `set_room_timer`,
  `public_table_names`. Going through a definer function is the point in each
  case — it is what lets the connect pair be normalized, `set_by` recorded as
  the caller rather than trusted from the client, and the room-membership policy
  escape its own recursion.
- **`rls_auto_enable()` is executable by both client roles** (WARN). It backs
  the platform's `ensure_rls` event trigger, is owned by `postgres`, and appears
  in no migration here — it is platform configuration, not ours to revoke.
- **Leaked-password protection is disabled** (WARN) — see the auth section.

Two things deliberately **not** changed:

- The four tables above still carry Supabase's default table grants to `anon`
  and `authenticated`. `0008` revoked them from `invite_codes` as
  belt-and-suspenders, and its descendant `connect_tokens` did not inherit that.
  Revoking now would turn the transparency screen's row count from `0` into
  `null` (which the screen already handles, and which is arguably more honest)
  but would also put a permission-denied string into the user's data export
  where an empty list is today. Not worth it while RLS already fails closed.
- `conversation_list()` is `SECURITY INVOKER`. It reads past nothing; the
  existing RLS on `friendships`, `profiles` and `messages` scopes every row.

## Notes

- Media cleanup is client-side: the newest 20 media per conversation are kept,
  older files removed on upload and re-checked when a chat opens. The
  disappearing-message sweep (`0029`) is the only server-side deletion.
- `.env` holds the project URL and publishable key. Keys are not pasted into
  this file, and secrets never belong in the repo at all.
