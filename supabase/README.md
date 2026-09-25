# `supabase/`

Everything the server side of Nearside is made of. Each path here answers a
different question:

| Path | Question it answers |
|------|---------------------|
| [`schema.sql`](schema.sql) | What does the database look like **now**? |
| [`migrations/`](migrations/) | How did it get that way, and what do I run against the live project? |
| [`storage/setup.sql`](storage/setup.sql) | What are the three buckets, and who can read them? |
| [`functions/`](functions/) | What runs off the database, with a service-role key? |
| [`SETUP.md`](SETUP.md) | What is actually deployed on the live project right now? |
| [`verify/`](verify/) | Prove the first two agree. |

## Starting from nothing

On a fresh Supabase project, in the SQL editor, in this order:

```
schema.sql
storage/setup.sql
```

Then enable `pg_cron` (Database → Extensions) and schedule the expiry sweep.
That is the one statement `schema.sql` cannot contain, because `cron.schedule`
fails on a re-run and would make the whole file unsafe to re-run:

```sql
SELECT cron.schedule('nearside-expire', '* * * * *',
                     $cron$ SELECT public.expire_messages(); $cron$);
```

`schema.sql` is not a migration. It builds the current shape directly and knows
nothing about the shapes that came before, so it must never be run against a
database that already holds data.

Then, in the dashboard, **Authentication → URL Configuration**: add your site
URL and a `/*` redirect so password-reset links come back, and add both deep
links to **Additional Redirect URLs**. GoTrue rejects any `redirect_to` not on
the list, and the emailed link then falls back to the site URL, which no phone
can open:

```
app.nearside://auth/confirm
app.nearside://auth/recovery
```

Last, the edge functions. `delete-account` needs no configuration; the other
four are optional and inert until their secrets are set:

```bash
supabase functions deploy send-push --no-verify-jwt
supabase secrets set ONESIGNAL_APP_ID=... ONESIGNAL_REST_API_KEY=...

supabase functions deploy call-ring     # the push that wakes a locked phone
supabase functions deploy call-ice      # short-lived TURN credentials per call
supabase secrets set CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=...

supabase functions deploy report-user   # Report → email ticket to the inbox
supabase secrets set RESEND_API_KEY=...
```

Both keys are server-side only. Vite inlines every `VITE_`-prefixed variable
into the bundle, so either one in `.env` ships inside every APK — a long-lived
TURN secret there is a free relay for anyone who unzips it. Without `call-ring`
a call only reaches a friend who already has the app open; without `call-ice`
calls fall back to STUN alone and the ones behind carrier-grade NAT never
connect. What is deployed on the live project is [`SETUP.md`](SETUP.md).

## Changing the live project

`migrations/` is the only safe path, and it is applied **by hand in the SQL
editor**, since there is no `supabase db push` here. Read
[`migrations/README.md`](migrations/README.md) before running anything: apply
order is not numeric order, and several files supersede parts of earlier ones.

A schema change is two edits, always:

1. a new numbered file in `migrations/`, added to
   [`migrations/apply-order.txt`](migrations/apply-order.txt)
2. the same change folded into `schema.sql`

Then `npm run db:verify`, which fails if you did one and not the other.

## `npm run db:verify`

Builds two throwaway databases inside one disposable Postgres container, one
by replaying every migration in order and one from `schema.sql`, then compares
their catalogs: tables, columns, constraints, indexes, RLS policies, function
bodies, triggers, grants, realtime membership and bucket configuration.

It needs Docker and nothing else. No Supabase account, no credentials, and no
path by which it could reach the live project. Because the migrations are
hand-applied to a database with no undo, this is also the place to dry-run a
new one before pasting it into the SQL editor: add the file, add it to
`apply-order.txt`, and see whether the replay survives it.

`verify/platform-shim.sql` stands in for the parts of Supabase a stock Postgres
image does not have: the `auth` and `storage` schemas, the `anon` /
`authenticated` roles, the realtime publication. It is a stub, not an emulator:
it makes the DDL apply and the result comparable, and it enforces nothing.

## `npm run db:audit -- '<connection string>'`

The question `db:verify` cannot reach: is the live project actually the
database these files describe? Migrations here are applied by hand in a
dashboard, so the only record that one ran is somebody's memory of running it,
and a migration that never ran leaves nothing behind to notice.

It builds the reference from `schema.sql` in the same throwaway container
(running `db:verify` first, so the reference is proven rather than assumed),
fingerprints the live project with the same `verify/introspect.sql`, and diffs.
Every statement it sends the live project is a catalog `SELECT`: it creates
nothing, writes nothing and drops nothing.

Three headings come out of it. **MISSING FROM LIVE** is a migration that never
ran. **EXTRA ON LIVE** is usually the platform and occasionally drift worth
looking at. **WRONG BODY ON LIVE** is the one nothing else can see: a
`SECURITY DEFINER` function that exists, is granted, and holds an older
migration's definition. `db:verify` is blind to that by construction — both
sides of its diff hold the same body, right or wrong — and plpgsql does not
resolve a body until it runs, so the first report is a user saying a button
does not work.

Extensions are listed rather than diffed: a Supabase project carries a dozen
the migrations here never install, and burying real findings under them would
defeat the point. `pg_net` is the exception, checked by name, because `0014`
installs it and the push trigger cannot post without it.

## `verify/applied.sql` — the cheap triage

`db:audit` is the thorough answer and it wants Docker, `psql` and the database
password. This one wants a browser tab: paste the file into the SQL editor and
it prints one row per file in `migrations/apply-order.txt`, `OK` or `MISSING`,
from whatever that file leaves behind in the catalog. It reads only.

It answers "which *file* never ran", not "which fact is wrong" — each row
checks one or two markers, so a migration that applied halfway can still read
`OK`, and a few early files (`0002`, `0010`, `0012`) were undone by later ones
and report `n/a` because there is nothing left to look at. When it is green,
`db:audit` is still the thing that says the database is the right shape.

## Where the guarantees actually live

- **No message body reaches Postgres.** `messages` and `room_messages` carry a
  ciphertext, a nonce and metadata. There is no column a plaintext could arrive
  in, because `0023` dropped the last one, and `src/lib/no-plaintext.test.ts`
  fails the build if a body ever reaches an insert payload.
- **Previews and search are local.** They read a per-device SQLite mirror
  (`src/lib/localdb.ts`), which is why a conversation is unsearchable on a
  device that never loaded it. That looks like a bug and is the design.
- **Attachments are sealed before upload** with a random per-file key that
  travels sealed on the message row. Deleting the row destroys the only copy of
  that key, so expired media is unopenable rather than merely unlisted.
- **Notifications carry a sender and never content**, because the server has no
  content to leak.
