# `supabase/`

Everything the server side of Nearside is made of. Four things live here, and
they answer different questions:

| Path | Question it answers |
|------|---------------------|
| [`schema.sql`](schema.sql) | What does the database look like **now**? |
| [`migrations/`](migrations/) | How did it get that way, and what do I run against the live project? |
| [`storage/setup.sql`](storage/setup.sql) | What buckets exist and who can read them? |
| [`functions/`](functions/) | What runs off the database, with a service-role key? |
| [`SETUP.md`](SETUP.md) | What is actually deployed on the live project right now? |
| [`verify/`](verify/) | Prove the first two agree. |

## Starting from nothing

On a fresh Supabase project, in the SQL editor, in this order:

```
schema.sql
storage/setup.sql
```

Then enable `pg_cron` (Database → Extensions) and schedule the expiry sweep —
the one statement `schema.sql` cannot contain, because `cron.schedule` fails on
a re-run and would make the whole file unsafe to re-run:

```sql
SELECT cron.schedule('nearside-expire', '* * * * *',
                     $cron$ SELECT public.expire_messages(); $cron$);
```

`schema.sql` is not a migration. It builds the current shape directly and knows
nothing about the shapes that came before, so it must never be run against a
database that already holds data.

## Changing the live project

`migrations/` is the only safe path, and it is applied **by hand in the SQL
editor** — there is no `supabase db push` here. Read
[`migrations/README.md`](migrations/README.md) before running anything: apply
order is not numeric order, and several files supersede parts of earlier ones.

A schema change is two edits, always:

1. a new numbered file in `migrations/`, added to
   [`migrations/apply-order.txt`](migrations/apply-order.txt)
2. the same change folded into `schema.sql`

Then `npm run db:verify`, which fails if you did one and not the other.

## `npm run db:verify`

Builds two throwaway databases inside one disposable Postgres container — one
by replaying every migration in order, one from `schema.sql` — and compares
their catalogs: tables, columns, constraints, indexes, RLS policies, function
bodies, triggers, grants, realtime membership and bucket configuration.

It needs Docker and nothing else. No Supabase account, no credentials, and no
path by which it could reach the live project. Because the migrations are
hand-applied to a database with no undo, this is also the place to dry-run a
new one before pasting it into the SQL editor: add the file, add it to
`apply-order.txt`, and see whether the replay survives it.

`verify/platform-shim.sql` stands in for the parts of Supabase a stock Postgres
image does not have — the `auth` and `storage` schemas, the `anon` /
`authenticated` roles, the realtime publication. It is a stub, not an emulator:
it makes the DDL apply and the result comparable, and it enforces nothing.

## Where the guarantees actually live

- **No message body reaches Postgres.** `messages` and `room_messages` carry a
  ciphertext, a nonce and metadata. There is no column a plaintext could arrive
  in — `0023` dropped the last one — and `src/lib/no-plaintext.test.ts` fails
  the build if a body ever reaches an insert payload.
- **Previews and search are local.** They read a per-device SQLite mirror
  (`src/lib/localdb.ts`), which is why a conversation is unsearchable on a
  device that never loaded it. That looks like a bug and is the design.
- **Attachments are sealed before upload** with a random per-file key that
  travels sealed on the message row. Deleting the row destroys the only copy of
  that key, so expired media is unopenable rather than merely unlisted.
- **Notifications carry a sender and never content**, because the server has no
  content to leak.
