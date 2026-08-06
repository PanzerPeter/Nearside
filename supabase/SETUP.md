# Supabase setup

## Status: 0001–0011 all applied ✅

Every migration in this directory is live on the **Chatly** project
(`REDACTED-PROJECT-REF`, eu-west-1), and the database was wiped of test data first,
so it holds no accounts, messages or friendships.

| File | Adds | State |
|------|------|-------|
| `0001_init.sql` | profiles, friendships, messages, RLS, signup trigger, realtime | applied |
| `0002_push_subscriptions.sql` | Web Push subscription storage | applied |
| `0003_reactions_replies.sql` | emoji reactions, reply-to | applied |
| `0004_friendships_realtime.sql` | friendships on the realtime publication | applied |
| `0005_messages_immutable_participants.sql` | sender/receiver reassignment guard | applied |
| `0006_message_receipts.sql` | read/delivered watermarks, unread counts, ✓✓ ticks | applied |
| `0007_conversation_list.sql` | sidebar RPC | **superseded by 0011, never run** |
| `0008_invite_codes.sql` | invite-gated signup + profile lockdown | applied |
| `0009_rate_limits.sql` | per-user message and friend-request limits | applied |
| `0010_message_search.sql` | in-conversation message search | applied |
| `0011_last_seen.sql` | `last_seen_at`, re-declares `conversation_list()` | applied |

> **`0018_forwarded_messages.sql` is not applied yet — apply it before shipping
> the forward feature.** It adds `messages.forwarded` and extends the 0005
> immutability trigger to cover it. Until it runs, PostgREST does not know the
> column and every forward fails with `PGRST204`; the client surfaces that as
> "Forwarding is not set up on the server yet" rather than a generic error.
>
> (This table stops at 0011 and has not been kept up as 0012–0017 landed — treat
> it as a record of the initial rollout, not a live inventory.)

**Do not re-run 0001, and do not run 0007 at all.** Each file is written to be
re-runnable in isolation, but **later migrations supersede parts of earlier ones**:
0001's `handle_new_user` predates the invite gate and is created with
`CREATE OR REPLACE`, so re-running it reopens registration to anyone; 0007's
seven-column `conversation_list()` can no longer replace 0011's eight-column one and
errors out. Read a file's header banner before re-running it.

---

## Verified state

- **Schema** — every function present with the expected signature:
  `conversation_list()` (8 columns, incl. `last_seen_at`), `unread_counts()`,
  `search_messages(uuid, text)`, `search_profiles(text)`, `handle_new_user()`.
- **RLS** — enabled on all 7 public tables. `invite_codes` deliberately has zero
  policies *and* has its `anon`/`authenticated` grants revoked, so the lockdown is
  structural rather than policy-dependent.
- **Realtime** — `messages`, `message_reactions`, `message_receipts`, `friendships`.
  (`friendships` was missing until this pass: 0004 had never actually landed, which
  would have left friend requests requiring a page reload to appear.)
- **Invite gate** — exercised against the live Auth API: signup with no code is
  rejected with `invite_required`, and signup with an unknown code with
  `invite_invalid`. Neither leaves an orphan `auth.users` row.
- **Security advisors** — 3 notices, all understood and accepted:
  `invite_codes` RLS-with-no-policy (INFO, intentional), `pg_trgm` installed in
  `public` (WARN, where `0010` puts it), and `search_profiles` being a
  `SECURITY DEFINER` function callable by `authenticated` (WARN, which is the entire
  point of the function — it reads past the narrowed profile policy on purpose and is
  fenced by a 3-char minimum prefix and a `LIMIT 10`).
- **Storage** — `avatars` (public, 5 MB) and `chat-media` (private, 50 MB) buckets
  with their owner/participant policies. The `storage.objects` rows from the test
  accounts could not be deleted over SQL (Supabase blocks it to avoid orphaning the
  underlying files); empty both buckets from the dashboard to finish the cleanup.

`.env` holds the project URL + publishable key, so `npm run dev` works.

### Sign in for the first time
Signup is invite-gated, so registration needs a code. Two unused codes are already
minted — retrieve them with the query at the end of this file, or mint more the same way.

The `.sql` files are kept for reproducibility. Each is written to be re-runnable in
isolation, but **later migrations supersede parts of earlier ones** — re-running an
early file can revert a later one's changes. Read a file's header banner before
re-running it; 0001 and 0007 both carry warnings.

## Remaining tasks (you — dashboard only, ~2 min)

These can't be set via the API, so they're manual:

### 1. Auth URL configuration (required for password reset)
Authentication → **URL Configuration**:
- **Site URL**: your deployed origin, e.g. `https://<your-site>.netlify.app`
- **Redirect URLs**: add both
  - `http://localhost:5173` (local dev)
  - `https://<your-site>.netlify.app`

Password-reset and email-confirmation links only redirect back to allow-listed URLs.

### 2. Email confirmation (optional preference)
Authentication → Providers → Email → **Confirm email**:
- **On** (default): new users must confirm before signing in — the app already handles this
  ("check your email" message). Profile is still created immediately by the trigger.
- **Off**: instant sign-in after signup (handy while testing).

### 3. Deploy to Netlify
- Connect the repo; `netlify.toml` sets build (`npm run build`) + publish (`dist`) + SPA redirect.
- Site settings → Environment variables:
  - `VITE_SUPABASE_URL = https://REDACTED-PROJECT-REF.supabase.co`
  - `VITE_SUPABASE_ANON_KEY = REDACTED-PUBLISHABLE-KEY`
- After the first deploy, go back to task 1 and set Site URL to the real Netlify URL.

## Push notifications (message alerts)

Added for foreground + background message notifications.

**Applied via MCP already ✅**
- `0002_push_subscriptions.sql` — `push_subscriptions` table (one row per device
  endpoint) + RLS (own-rows only). The `send-push` function reads it via service role.
- `send-push` Edge Function deployed (`verify_jwt = on`). The sender's browser calls it
  fire-and-forget after each message; it confirms the caller authored the message, then
  Web-Pushes the receiver's subscriptions (pruning dead ones on 404/410).

**Remaining tasks (you — dashboard, ~2 min):**

### 1. Set the Edge Function secrets
Dashboard → **Edge Functions → send-push → Secrets** (or Project Settings → Edge Functions):
- `VAPID_PUBLIC_KEY` = the public key, same value as `VITE_VAPID_PUBLIC_KEY` in `.env`
- `VAPID_PRIVATE_KEY` = the private key from your key pair — **never write it in this
  file or anywhere else in the repo.** A draft revision of this document did; that was
  caught and scrubbed from this branch's history before the branch was ever pushed, so
  the pair was never published. Rotating it anyway is cheap and removes all doubt.
- `VAPID_SUBJECT` = `mailto:you@yourdomain.com` (your contact address)
  - Must be a **plain** `mailto:` or `https:` value — no Markdown link `[url](url)`,
    quotes, or brackets, or `web-push` rejects it. (`send-push` now normalizes
    common mistakes, but keep it clean.)

The **public** key is also in `.env` as `VITE_VAPID_PUBLIC_KEY` (already set). Keep the
**private** key only in the Edge Function secrets — never in the client. Rotate anytime by
regenerating a pair (`npx web-push generate-vapid-keys`) and updating both places.

### 2. Netlify env var
Add `VITE_VAPID_PUBLIC_KEY` (same public value) to Netlify → Site settings → Environment
variables, so production builds ship the key.

### Testing
- **Foreground sound** works everywhere, including `npm run dev`.
- **Notifications / background push** need a registered service worker, which only runs in a
  production build — test with `npm run build && npm run preview` (or a deploy), not `npm run dev`.
- Enable notifications in the app via **Settings → Message notifications**.
- iOS only supports Web Push for an **installed** PWA (16.4+); elsewhere it falls back to the
  foreground sound + notification automatically.
- If background pushes 500, check the function logs — most likely the VAPID secrets above
  aren't set yet.

## Server-side push delivery (`0014_server_side_push.sql`) — **opt-in, not yet applied**

Until now the *only* thing that asked for a push was the sender's browser, right
after the insert, fire-and-forget. That drops the notification whenever the
sender's browser doesn't outlive the request: send a message and lock the phone,
lose signal a second later, or sit on a route that can reach Postgres but not the
Functions host. The message stores; the receiver is simply never told.

`0014` adds a database `AFTER INSERT` trigger that calls `send-push` over `pg_net`,
so delivery no longer depends on the sender's tab. Both callers stay live and are
de-duplicated by a claim row in `message_pushes`, so a race produces one
notification, not two.

**The migration is inert until you configure it** — with no `push_config` row the
trigger returns immediately. To turn it on:

1. Run `0014_server_side_push.sql` in the SQL editor.
2. Pick a long random secret (`openssl rand -hex 32`).
3. Set it as an Edge Function secret: `PUSH_TRIGGER_SECRET` = that value.
4. Redeploy the function **without JWT verification**, because the database has no
   user to authenticate as:

   ```bash
   supabase functions deploy send-push --no-verify-jwt --project-ref REDACTED-PROJECT-REF
   ```

   Authorisation then lives in the function: a request is accepted only if it
   carries a valid user JWT *and* that user authored the message, or it carries a
   matching `x-push-secret`. Everything else is rejected.
5. Point the trigger at the function (SQL editor, service role):

   ```sql
   insert into public.push_config (function_url, trigger_secret)
   values (
     'https://REDACTED-PROJECT-REF.supabase.co/functions/v1/send-push',
     'the-same-secret-from-step-2'
   )
   on conflict (id) do update
     set function_url = excluded.function_url,
         trigger_secret = excluded.trigger_secret,
         updated_at = now();
   ```

To back it out: `delete from public.push_config;` — the trigger goes inert again
and the browser path keeps working on its own.

Order matters. Doing step 5 before steps 3–4 makes every insert fire an HTTP call
the function rejects; harmless (the trigger swallows errors so a send never fails)
but pointless. Doing step 4 before step 3 leaves the function briefly deployed with
no JWT check *and* no secret configured — `PUSH_TRIGGER_SECRET` being unset makes
`secretMatches` return false for everything, so unauthenticated callers are still
rejected, but set the secret first anyway.

## Invite-gated signup

`0008_invite_codes.sql` closes open registration: `handle_new_user` now requires
a valid, unused row in `public.invite_codes` (passed as `invite_code` in the
signup metadata) or the signup aborts. Profile visibility is also narrowed —
`profiles_select_connected` replaces the old "every authenticated user" policy
with "myself, my friends, and anyone with a pending request either way".
Stranger discovery only happens through `search_profiles(prefix)`, a
`SECURITY DEFINER` RPC that requires a 3+ character prefix and caps results at 10.

**Mint a code** (SQL editor, as a superuser — the table has no client-facing
policies):

```sql
insert into public.invite_codes (code, note)
values ('some-code-here', 'who this is for');
```

**See which codes are unspent:**

```sql
select code, note, used_by, used_at from public.invite_codes where used_by is null order by created_at;
```

## Account deletion (self-service)

Settings → **Danger zone → Delete account** calls the `delete-account` Edge Function,
which resolves the caller from their JWT, removes their `avatars/{uid}/` objects and
every `chat-media` conversation folder they are a participant in, then deletes the
`auth.users` row (cascading messages, friendships, reactions, receipts and push
subscriptions via `profiles.id`).

**Not deployed yet — you deploy it.** This is the only step here that uses the
Supabase CLI, which is not a project dependency: install it once and run
`supabase login` before the command below.

```bash
supabase functions deploy delete-account --project-ref REDACTED-PROJECT-REF
```

Like `send-push` it runs with `verify_jwt` on and needs **no secrets**: the
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` it uses are injected
by the Edge runtime.

Notes:
- It deletes the user's spent row in `invite_codes` first, because `used_by` references
  `auth.users(id)` with no `ON DELETE` action and would otherwise block the delete. The
  code does **not** return to the unused pool — the row is gone, not reset.
- Storage is cleared **before** the auth user, because the object paths are derived from
  the uid and the conversation keys, both of which disappear with the account. If it
  fails after clearing storage, the account still exists and the call is safe to retry.
- Test it with a throwaway account (mint a spare invite code, sign up, delete) rather
  than your own — there is no undo and no backup.

## Notes
- Media cleanup is client-side: newest 20 media per conversation are kept; older files are
  removed on upload and re-checked when a chat opens. Want a server-side `pg_cron` + Edge
  Function sweep instead? Ask — I can deploy it via MCP now that it's connected.
- Always create users through the app (the signup trigger needs `username` in metadata).
