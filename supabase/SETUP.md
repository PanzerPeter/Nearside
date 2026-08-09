# Supabase setup

Migrations `0001`–`0025` and `0029` are live on the project named in `.env`. The project ref
is deliberately not written down here: it is the API host, it is not rotatable,
and a public repo is no place to hand out a target for free.

`0001`–`0019a` were replayed onto this project during Plan 1; `0020` onward were
applied individually and are the ones the migration history table records. The
`.sql` files are kept for reproducibility, but **later migrations supersede parts
of earlier ones** — re-running an early file can revert a later one. Every file
that is dangerous to re-run says so in its header banner. Read it first.

The migrations that changed what the server can see, in order:

| File | Effect |
|------|--------|
| `0019_open_signup.sql` | dropped the invite gate and `invite_codes`; anyone can register |
| `0020_identity_keys.sql` | `profiles.public_key` / `signing_key` / `key_updated_at` |
| `0021_encrypted_bodies.sql` | `messages.ciphertext` / `nonce` alongside the old `content` |
| `0022_display_name.sql` | `profiles.username` → `display_name`, UNIQUE and format constraints dropped |
| `0023_server_stops_reading_bodies.sql` | dropped `messages.content` and `search_messages()` |
| `0024_encrypted_media.sql` | `media_key_ciphertext` / `media_key_nonce` |
| `0025_sealed_media_mime.sql` | `chat-media` accepts `application/octet-stream` |
| `0029_disappearing.sql` | `conversation_timers`, `rooms.ttl_seconds`, a trigger-stamped `expires_at`, and a `pg_cron` sweep that hard-deletes expired rows |

**`0029` is applied**, along with the two things the file itself cannot do:

1. **The `pg_cron` extension** (1.6.4, in `pg_catalog`). Enabled first; the
   file's functions do not depend on it, but the sweep never runs without it.
2. **A one-off `cron.schedule` call**, quoted in the comment block at the bottom
   of the file and deliberately left out of the main body — it fails with a
   duplicate-jobname error if re-run, which would make the rest of the file
   unsafe to re-run. Without it the columns and triggers exist and stamp
   correctly, and nothing is ever deleted.

Job `nearside-expire`, `* * * * *`, active. Confirm with:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'nearside-expire';
SELECT status, return_message, start_time FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'nearside-expire')
 ORDER BY start_time DESC LIMIT 5;
```

The two new RPCs show up in the security advisor as `SECURITY DEFINER`
functions callable by `authenticated`. That is intentional and is the same
notice `redeem_connect_code` and `rooms_for_me` already carry: going through a
definer function is what lets the pair be normalized and `set_by` recorded as
the caller rather than trusted from the client. `expire_messages` and the two
stamping triggers are revoked from `anon` and `authenticated` and raise no
notice.

## `0030_theme_grants.sql` — **not applied yet**

Adds `theme_grants` plus `grant_theme_packs()` / `revoke_theme_grants()`, so a
demo or review account can own theme packs nobody paid for. Nothing else depends
on it: without the table the client's grant read fails and every account falls
back to whatever RevenueCat says it owns, which is the behaviour that shipped.

Paste the file into the SQL editor as `postgres`. It is idempotent and safe to
re-run. Then, per account:

```sql
SELECT public.grant_theme_packs('tester@example.com');   -- all six packs
SELECT public.revoke_theme_grants('tester@example.com'); -- take them back
```

Both functions are `SECURITY DEFINER` and **revoked from `authenticated` and
`anon`** — they read `auth.users` by email, and a client that could call them
would be able to award itself the entire catalogue. Expect the advisor to flag
them as definer functions; unlike the `0029` pair, these have no EXECUTE grant
behind them. The table itself grants `SELECT` only, so the app can see what it
owns and has no write path at all.

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

`storage-setup.sql` creates both buckets and their policies. Run it once, after
`0001`, and note that it carries the same mime list as `0025` — if you edit one,
edit the other, or re-running the setup script silently reverts the migration.

- `avatars` — public, 5 MB, image types. Avatars are not sealed.
- `chat-media` — private, 50 MB, `application/octet-stream` plus image types.
  Attachments go up sealed as octet-stream; the image types are there because
  chat backgrounds share this bucket and are not sealed.

Policies key `chat-media` off the conversation folder
(`{sortedUidA}_{sortedUidB}/`), so only the two participants can read or write.

## Edge functions — **none are deployed**

`list_edge_functions` on this project returns an empty list. Both functions in
`supabase/functions/` exist only as source:

- **`delete-account`** — needed. Settings → Danger zone calls it, and the call
  fails until it is deployed. It resolves the caller from their JWT, removes
  their `avatars/{uid}/` objects and every `chat-media` conversation folder they
  participate in, then deletes the `auth.users` row (cascading messages,
  friendships, reactions, receipts and push subscriptions through
  `profiles.id`). Storage is cleared before the auth user, because the paths are
  derived from ids that disappear with the account; a failure after that point
  leaves the account intact and the call safe to retry.

  ```bash
  supabase functions deploy delete-account --project-ref "$SUPABASE_PROJECT_REF"
  ```

  It runs with `verify_jwt` on and needs no secrets — `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the Edge
  runtime. Test it with a throwaway account: there is no undo and no backup.

- **`send-push`** — the Web Push transport, and probably not worth deploying.
  `VITE_VAPID_PUBLIC_KEY` is unset in `.env`, so `pushSupported()` is false and
  the client never subscribes; only the foreground sound and notification path
  runs. Plan 5 Task 3 replaces this whole transport with OneSignal and deletes
  `src/lib/vapid.ts`, `src/lib/push.ts` and the service worker's push handlers.
  Deploy it only if you want background push working before then, in which case
  it needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Edge Function secrets only,
  never the repo) and a plain `mailto:`/`https:` `VAPID_SUBJECT`.

`0014_server_side_push.sql` is applied but inert: `push_config` is empty, so the
`AFTER INSERT` trigger returns immediately. It exists so delivery does not depend
on the sender's browser outliving the request. Turning it on means deploying
`send-push` with `--no-verify-jwt`, setting `PUSH_TRIGGER_SECRET`, and inserting
a `push_config` row pointing at the function URL with the same secret — in that
order, and it is also superseded by Plan 5.

## Security advisors — current state

Nine notices, all understood:

- `message_pushes` and `push_config` have RLS enabled with no policies (INFO).
  Intentional: both are server-side, reached only by the service role and the
  trigger. No policy is the lockdown.
- `pg_trgm` and `pg_net` live in `public` (WARN) — where `0010` and `0014` put
  them.
- `search_profiles(text)` is `SECURITY DEFINER` and callable by `anon` and
  `authenticated` (WARN). That is the point of the function: it reads past the
  narrowed profile policy on purpose, fenced by a 3-character minimum prefix and
  a `LIMIT 10`. **Plan 3 Task 6 deletes it** — it is the last piece of stranger
  discovery, and it survives only until Task 5's connect codes work on a device.
- `rls_auto_enable()` is likewise executable by both roles (WARN). Worth
  revoking; it is an event-trigger helper with no reason to be in the API
  surface.
- Leaked-password protection is disabled (WARN) — see the auth section.

## Notes

- Media cleanup is client-side: the newest 20 media per conversation are kept,
  older files removed on upload and re-checked when a chat opens. Plan 5 replaces
  this with a server-side sweep.
- `.env` holds the project URL and publishable key. Keys are not pasted into this
  file, and secrets never belong in the repo at all.
