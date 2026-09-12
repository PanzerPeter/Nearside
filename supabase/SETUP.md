# The live project

What is actually deployed, as against [`README.md`](README.md) (what the folder
is) and [`migrations/README.md`](migrations/README.md) (what each file does).
The project ref is deliberately not written down here: it is the API host, it is
not rotatable, and a public repo is no place to hand out a target for free. It
lives in `.env` and in `supabase/.temp/`, both gitignored.

Anything below that says "confirm with" is a claim this file cannot keep true on
its own. Run the query before trusting it.

## Migrations

Every migration in
[`migrations/apply-order.txt`](migrations/apply-order.txt) is live, `0001`
through `0050`, with two exceptions, both still to apply:

- **`0038_alert_ladder.sql`** — `streak` is on neither `push_alerts` nor
  `room_push_alerts`. Until it is, the notification ladder has no memory: the
  anchor write names a column the table does not have, so it is dropped and
  every message rings at full volume. Nobody reports that as a bug, which is
  why the audit below is the thing that found it.
- **`0049_pin_sender_column.sql`** — pinning a message in a 1:1 conversation
  fails until it lands (see below). `0050`, which repairs the other half of the
  same feature, *is* applied, so a pin would already reach the other person if
  one could be made.

**Do not trust this paragraph — run the audit.** The list above was wrong twice
before: it claimed `0038` was applied when it was not, and it claimed `0049`
and `0050` were both outstanding when only `0049` was. Every entry here is a
memory of a dashboard session, and the database is the only thing that knows.

```bash
npm run db:audit -- 'postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
```

`verify/live-audit.sh` runs `verify/introspect.sql` — the same fingerprint
`db:verify` compares its two throwaway databases with — against the live
project, and diffs 677 facts: every table, column, default, constraint, index,
policy, trigger, grant, realtime publication, storage bucket and function body.
It reads and writes nothing. Three headings come out of it:

- **WRONG BODY ON LIVE** — a function that exists and is granted and holds the
  wrong definition. `db:verify` is blind to this by construction: both sides of
  its diff hold the same body, right or wrong. This is what `0049` was.
- **MISSING FROM LIVE** — a migration that never ran.
- **EXTRA ON LIVE** — platform objects (`rls_auto_enable`, storage defaults),
  noted further down this file. Anything else is drift, and a stray grant or
  policy is a finding rather than noise.

Every migration is idempotent enough to re-run — `0038` is
`ADD COLUMN IF NOT EXISTS`, `0049` is one `CREATE OR REPLACE FUNCTION`, `0050`
guards its publication add — so re-running one that is already there costs
nothing, and re-running all of a feature's files is the safe answer to a doubt.

The live database and `schema.sql` describe the same thing once the outstanding
ones are in, which is the assumption every `npm run db:verify` result is only
worth anything under.

`0044`–`0048` were applied individually as each shipped, and the paragraphs
below stopped at `0043` for a while rather than the database doing so. The query
above covers the pin tables; anything else is `to_regclass` away.

### `0049_pin_sender_column.sql` — **not applied yet, and the 1:1 pin is broken until it is**

`0048` asked `messages` for `sender_id`. That column belongs to
`room_messages`; the 1:1 table has called the sender `user_id` since `0001`. A
plpgsql body is stored as text and resolved only when it runs, so the migration
applied without complaint and every 1:1 pin has been failing since with
`column m.sender_id does not exist` — which the app can only report as "Could
not change the pinned message." Groups were never affected: `set_room_pin`
names the column `room_messages` actually has.

Apply `0049` in the SQL editor. It is one `CREATE OR REPLACE` over
`set_conversation_pin` and touches nothing else. Confirm the pin works
afterwards from the app, or here with a message id you own:

```sql
SELECT public.set_conversation_pin('<peer uuid>', '<message uuid>');
```

`supabase/verify/smoke.sql` now calls both pin functions during
`npm run db:verify`, which is how this class of fault gets caught before it
reaches a project: a catalog diff cannot see it, because both sides of the diff
held the same wrong body.

### `0050_pin_realtime.sql` — applied

`0048` created `conversation_pins` and `room_pins` outside the realtime
publication. Both clients subscribe to changes on those tables, so the person
who pinned saw the banner — their own client re-reads after the write — and
nobody else did until they reopened the conversation. `0050` adds both tables
to `supabase_realtime`, sets `REPLICA IDENTITY FULL` so an unpin (a DELETE) can
be evaluated against the SELECT policy, and reloads PostgREST's schema cache.

It landed while `0049` did not, which is worth remembering as a shape: the two
halves of one feature were applied in one sitting and only one of them took.
Nothing reported the gap, because a fix for a feature that cannot run yet looks
exactly like a fix that worked.

`0034` was applied before `0033`, a departure from the apply order and a safe
one: the two files touch nothing in common. `0033` adds the `stickers` table
and widens the `messages_media_type_check` CHECK, `0034` adds triggers,
constraints and policies elsewhere, and neither replaces a function or policy
the other creates. `npm run db:verify` against the swapped order fingerprints
identically to `schema.sql`, so the database this project holds is the one this
repo describes regardless of which of the two landed first.

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
UPDATE grant, because an editable answer would defeat the protocol.

`0031_grant_hygiene.sql` is applied. It was two corrections found by replaying
the folder into a throwaway Postgres (`npm run db:verify`) rather than by
anything the app did, and neither was reachable from the app:

- `conversation_list()` was executable by `anon`. `0022` revoked it; `0023`
  rebuilt the function with `DROP FUNCTION`, required because removing
  `last_message` changes the return type, and the new one was created without
  a REVOKE, so the default `EXECUTE TO PUBLIC` came back. Not a disclosure: with
  no JWT `auth.uid()` is NULL, `peers` is empty and the join to `profiles`
  matches nothing, so an anonymous call returned zero rows. What it closed is an
  unintended endpoint at `/rest/v1/rpc/conversation_list`, which is the class
  `0019a` exists to close.
- `chat_backgrounds`'s primary key was named `chat_backgrounds_pkey1`, because
  `0013` renamed the pair-shaped table aside before creating the new one beside
  it. Cosmetic, and it was the one place a database built from `schema.sql`
  differed from a replay of this folder.

Both statements are guarded and re-running the file is safe. Confirm with:

```sql
SELECT has_function_privilege('anon', 'public.conversation_list()', 'EXECUTE')
       AS should_be_false;
```

### `0029_disappearing.sql` — applied, plus two things the file cannot do

1. **The `pg_cron` extension** (1.6.4, in `pg_catalog`). The file's functions do
   not depend on it, but the sweep never runs without it.
2. **A one-off `cron.schedule` call**, quoted at the bottom of the file and
   deliberately left out of its body. It fails with a duplicate-jobname error
   if re-run, which would make the rest of the file unsafe to re-run.

Job `nearside-expire`, `* * * * *`, active. Confirm with:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'nearside-expire';
SELECT status, return_message, start_time FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'nearside-expire')
 ORDER BY start_time DESC LIMIT 5;
```

Without it the columns and triggers exist and stamp `expires_at` correctly, and
nothing is ever deleted, which is the failure mode that looks like the feature
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

Both are `SECURITY DEFINER` and revoked from `authenticated` and `anon`: they
read `auth.users` by email, and a client that could call them would be able to
award itself the entire catalogue. Confirm the lockdown survived a later
migration with:

```sql
SELECT has_function_privilege('authenticated',
         'public.grant_theme_packs(text, text[], text)', 'EXECUTE') AS should_be_false;
```

### `0033_stickers.sql` — applied, plus its bucket

The sticker library: the `stickers` table, and `'sticker'` added to
`messages_media_type_check`. It is two steps, because the table alone is half
the feature: the migration, then `storage/setup.sql`, which is written to be
re-run and creates the `stickers` bucket alongside the two that already exist.
Both are in:

```sql
SELECT to_regclass('public.stickers') IS NOT NULL AS table_live,
       (SELECT count(*) FROM pg_policies WHERE tablename = 'stickers') AS policies,
       EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'stickers') AS bucket_live;
```

Four policies on the table, four more on `storage.objects`. Sending a sticker is
the ordinary attachment path into `chat-media`, so nothing about it reaches the
`stickers` bucket. That bucket is the library, and it is owner-only on every
verb.

### `0034_write_guards.sql` — applied

Closes what a row-level policy cannot see, because it is shown one row and not
the change. The one that mattered: `friendships_update_addressee` pinned
`addressee_id` and left `requester_id` free, so the addressee of any row they
controlled could point it at a stranger, set `'accepted'`, and hold a friendship
that stranger was never asked for, which is the only gate in front of DMs and
published keys. Also: tombstones are final, `edited_at` is stamped by the server
rather than claimed by the client, `expires_at` and `created_at` stop being
writable after insert, `DELETE` on `messages` is gone as policy and as
privilege, `display_name` gets the bounds nicknames already had, a room's
creator can no longer leave it, `message_reactions` gets `REPLICA IDENTITY FULL`
(without it realtime silently dropped every reaction removal), and
`room_messages` and `message_reactions` get the rate limit `messages` has.

```sql
SELECT count(*) FILTER (WHERE tgname = 'friendships_prevent_reassign') AS friendship_guard,
       count(*) FILTER (WHERE tgname = 'messages_body_guard')          AS body_guard
  FROM pg_trigger WHERE NOT tgisinternal;

SELECT has_table_privilege('authenticated', 'public.messages', 'DELETE') AS should_be_false;

SELECT relreplident AS should_be_f
  FROM pg_class WHERE oid = 'public.message_reactions'::regclass;
```

It also repaired data on the way through: any `profiles.display_name` outside
1–32 trimmed characters or carrying a control character was rewritten, and any
second friendship row for a pair that already had one was deleted (accepted
kept over pending, then oldest). Both were no-ops on a project this client is
the only writer for.

### `0035`–`0037` — applied, the notification ladder and rooms catching up

(`0038`, described at the end of this section, is **not** applied — see
Migrations above. Everything here about the ladder describes the code, not this
project's behaviour, until it is.)

`0035_push_alerts.sql` gives `send-push` somewhere to remember when it last made
a receiver's phone make a noise, so a burst of messages arrives as one alert and
a run of silent notifications. `0036_room_parity.sql` gives rooms what 1:1 chats
already had: attachments, replies, reactions, edits, deletes and read state,
with the per-file key sealed under the *room* key rather than to one recipient,
and `sig_v` so the signature starts covering the new columns.
`0037_room_push.sql` makes a room message send a push at all, through
`room_message_pushes` (which claims the send) and `room_push_alerts` (which
throttles it per receiver per room). `0038_alert_ladder.sql` adds one integer
column to each of those two tables and nothing else.

```sql
SELECT to_regclass('public.push_alerts')         IS NOT NULL AS alerts_live,
       to_regclass('public.room_message_pushes') IS NOT NULL AS room_pushes,
       to_regclass('public.room_push_alerts')    IS NOT NULL AS room_alerts;
```

`send-push` has to be redeployed after `0037`: an older copy ignores
`room_message_id` and answers "message_id required", so rooms stay silent while
everything else looks healthy.

### `0039`–`0041` — applied, three columns that were still in the clear

- **`0039_sealed_backgrounds.sql`** seals chat backgrounds under the owner's
  vault key. They were the last image the app uploaded as a plain JPEG, into a
  folder whose policy opens it to both participants, so the picture behind your
  thread was readable by the server and by the person you were talking to.
  `chat_backgrounds` gets `key_ciphertext` / `key_nonce` and a both-or-neither
  CHECK. Rows written before it keep null keys, keep pointing at a plaintext
  object, and keep rendering; they are replaced when that person next sets one.
- **`0040_profile_bio.sql`** adds `profiles.bio`, deliberately plaintext. There
  is no key every friend of yours already holds, so sealing it would mean one
  ciphertext per friendship, re-sealed on every edit and repaired on every key
  rotation, for a paragraph that sits beside an avatar in a public bucket.
  `src/lib/server-view.ts` lists it among the readable columns of `profiles`,
  which is where the honest half of that decision lives.
- **`0041_sealed_nicknames.sql`** seals `friend_nicknames.nickname` under the
  owner's vault key, the same treatment stickers got in `0033`. The row was
  already owner-only, so there was no second party to seal to and no key to
  distribute. `nickname` becomes nullable and keeps its CHECKs; rows written
  before this still hold plaintext, render, and are re-sealed as each device
  meets them, so the old column empties itself.

```sql
SELECT count(*) FILTER (WHERE nickname IS NOT NULL) AS still_plaintext,
       count(*) FILTER (WHERE nickname_ciphertext IS NOT NULL) AS sealed
  FROM public.friend_nicknames;
```

### `0042`–`0043` — applied

`0042_token_hygiene.sql` removes three records the database was keeping for
nobody: `connect_tokens.used_by`, which nothing has ever selected and which was
a standing list of who added whom; spent connect codes, now swept by
`expire_messages()` but only once `expires_at` has passed, because deleting a
used code inside its ten minutes would free the string to be minted again; and
the `pg_trgm` extension, unused since `0023` took the column it indexed.

`0043_table_columns.sql` adds `public_table_columns()`, the counterpart of
`public_table_names()` from `0027`. The transparency screen could already catch
a table nobody had described; now it catches a column, which is what its
"server reads: …" lines actually claim. It reports names only, for `public`
only: no types, no defaults, no contents, no row counts.

```sql
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
         AS should_be_false,
       has_function_privilege('authenticated',
         'public.public_table_columns()', 'EXECUTE') AS should_be_true;
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
mid-upgrade still works. Names are not unique and have no format constraint:
people are found by connect code, not by name.

Always create users through the app; the trigger needs that metadata.

## Storage

[`storage/setup.sql`](storage/setup.sql) creates all three buckets and their
policies. It is written to be re-run, and the sticker bucket arrived that way
alongside `0033`.

- `avatars`: public, 5 MB, image types. Avatars are not sealed.
- `chat-media`: private, 50 MB, `application/octet-stream` plus image types.
  Attachments go up sealed as octet-stream. The image types are left over from
  chat backgrounds, which were plaintext until `0039` sealed them; rows written
  before that still point at a plain JPEG or PNG and still render, so the list
  can narrow to octet-stream alone once no null-key background rows are left.
- `stickers`: private, 1 MB, octet-stream only, owner-only on every verb. This
  is the library. Sending a sticker is the ordinary attachment path into
  `chat-media` and never touches this bucket.

Policies key `chat-media` off the conversation folder
(`{sortedUidA}_{sortedUidB}/`), so only the two participants can read or write.

The mime list appears both here and in `0025_sealed_media_mime.sql`, which used
to be a standing invitation to edit one and not the other. `npm run db:verify`
now applies the setup script down both paths and compares the resulting bucket
rows, so that drift fails instead of shipping.

## Wiping the demo data

[`maintenance/reset-data.sql`](maintenance/reset-data.sql) empties the project:
one `DELETE FROM auth.users` and the cascade takes every table with it. It is
not a migration, it is not in `apply-order.txt`, and `db:verify` does not read
it, since it makes no schema changes and touches only rows.

Two things in it are easy to get wrong and are the reason it is a documented
script rather than a one-liner someone types:

- **The buckets have to be emptied first, and not in SQL.**
  `storage.protect_delete()` raises on a direct DELETE from a storage table,
  and because the SQL editor runs a script as one transaction, that raise
  rolls back the `auth.users` delete with it, and the reset does nothing at
  all.
  [`maintenance/empty-buckets.mjs`](maintenance/empty-buckets.mjs) walks the
  three buckets through the Storage API; it takes `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` from the environment and has a `--dry-run`. The
  service_role key must not go in `.env`, which Vite reads and ships.
- **Every signed-in device has to sign out afterwards.** The server is not the
  only copy: each install holds a decrypted SQLite mirror, an outbox, pinned
  bytes, the account roster and a seed, and `App.signOut` is what clears them
  together.

`push_config` is left in place on purpose. `src/lib/reset-data.test.ts` checks
the script still names every table in `schema.sql`, so a table added later
cannot go quietly unaccounted for.

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
  call id and `voice`/`video`, and nothing else, because there is nothing else
  about a call the server holds. `CallNotificationExtension` intercepts it on the
  device and raises a full-screen ring in its place.

  ```bash
  supabase functions deploy call-ring --project-ref "$SUPABASE_PROJECT_REF"
  ```

  Shares `ONESIGNAL_APP_ID` and `ONESIGNAL_REST_API_KEY` with `send-push`.
  Without it a call still rings a friend who has the app open, since the offer
  goes over the realtime topic either way, and reaches nobody else.

- **`call-ice`** — needed for calls behind carrier-grade NAT, which on mobile
  networks is most of them. It mints Cloudflare TURN credentials against the
  caller's JWT, one set per call and good for an hour, inside a monthly egress
  budget it checks before minting (default 900 GB, under the free 1,000). The
  client falls back to STUN alone when this is unreachable, so a missing
  deployment is calls that mostly work and sometimes never connect, the worst
  failure mode there is to debug.

  ```bash
  supabase functions deploy call-ice --project-ref "$SUPABASE_PROJECT_REF"
  supabase secrets set CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=...
  ```

  Optional beside those: `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_ANALYTICS_API_TOKEN` for the relayed-bytes check, and
  `TURN_MONTHLY_BUDGET_GB` to stop minting credentials past a spend cap. The
  API token is server-side only: a long-lived TURN secret in the bundle is a
  free relay for anyone who unzips the APK.

- **`send-push`** — the OneSignal sender. Two callers: the sending device
  (`src/lib/push.ts`, which is the live path) and `0014`/`0037`'s database
  triggers. The triggers are applied but inert on this project, because
  `push_config` is empty, so both return immediately. Turning them on means deploying with
  `--no-verify-jwt`, setting `PUSH_TRIGGER_SECRET`, and inserting a
  `push_config` row pointing at the function URL with the same secret, in that
  order.

  It takes either `{ message_id }` or `{ room_message_id }`. The room branch
  fans out to `room_participants` minus the sender, claims the send in
  `room_message_pushes`, and throttles per receiver per room in
  `room_push_alerts`. A room banner carries the room's title and the sender's
  `@display_name`, never a private nickname, because one notification
  addresses many people at once, and never a body, because the server has none.

  Redeploy it after applying `0037`: an old copy ignores `room_message_id` and
  answers "message_id required", so rooms stay silent.

## Security advisors — current state

- **`message_pushes` and `push_config` have RLS enabled with no policies**
  (INFO). Intentional: both are server-side, reached only by the service role
  and the trigger. No policy is the lockdown, because RLS with no policy fails
  closed.
- **`connect_tokens` likewise.** Reachable only through `mint_connect_code()`
  and `redeem_connect_code()`, which are `SECURITY DEFINER` and revoked from
  `anon`. A client that could read the table could enumerate live codes.
- **`pg_net` lives in `public`** (WARN), where `0014` put it. It is kept there
  because moving an extension between schemas on a live project is not worth
  the risk of the move failing halfway. `pg_trgm` was beside it until `0042`
  dropped it: `0023` had already taken the trigram index and the column it
  covered, so the extension was left naming a capability the server no longer
  has.
- **`SECURITY DEFINER` functions callable by `authenticated`** (WARN):
  `redeem_connect_code`, `mint_connect_code`, `rooms_for_me`, `is_room_member`,
  `is_room_owner`, `set_conversation_timer`, `set_room_timer`,
  `public_table_names`. Going through a definer function is the point in each
  case: it is what lets the connect pair be normalized, `set_by` recorded as
  the caller rather than trusted from the client, and the room-membership policy
  escape its own recursion.
- **`rls_auto_enable()` is executable by both client roles** (WARN). It backs
  the platform's `ensure_rls` event trigger, is owned by `postgres`, and appears
  in no migration here. It is platform configuration, not ours to revoke.
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

- Media cleanup is client-side: the newest 20 photos and videos per
  conversation are kept, and the newest 50 voice notes, with older files
  removed on upload and re-checked when a chat opens. The disappearing-message
  sweep (`0029`), which `0042` extended to spent connect codes, is the only
  server-side deletion.
- `.env` holds the project URL and publishable key. Keys are not pasted into
  this file, and secrets never belong in the repo at all.
