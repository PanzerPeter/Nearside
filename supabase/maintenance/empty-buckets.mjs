#!/usr/bin/env node
/*
  Nearside — empty the storage buckets.
  Step 1 of `reset-data.sql`. See that file first.

  Postgres will not let you do this in SQL. `storage.protect_delete()` raises
  on any direct DELETE from a storage table:

      ERROR: Direct deletion from storage tables is not allowed.
             Use the Storage API instead.

  It is right to. A row in `storage.objects` is the only record of where a file
  lives; deleting it strands the bytes on S3 with nothing left that can name
  them. The API removes both. So this walks the three buckets and removes every
  object through it.

  Usage — the key is passed in, never read from a file:

      SUPABASE_URL=https://<ref>.supabase.co \
      SUPABASE_SERVICE_ROLE_KEY=<service_role key from the dashboard> \
      node supabase/maintenance/empty-buckets.mjs

      # and to see what it would remove without removing it:
      ... node supabase/maintenance/empty-buckets.mjs --dry-run

  The service_role key bypasses every RLS policy in the project. It does not
  belong in `.env` — that file is read by Vite and everything in it ships
  inside the app. Paste it into the command and let it leave with the shell.
*/

import { createClient } from '@supabase/supabase-js';

const BUCKETS = ['avatars', 'chat-media', 'stickers'];

/** Storage lists a page at a time; this is its maximum. */
const PAGE = 100;

/** Objects per remove() call. The API takes an array, not an unbounded one. */
const CHUNK = 100;

const dryRun = process.argv.includes('--dry-run');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. See the header of this file.'
  );
  process.exit(1);
}

// The anon key also reaches this endpoint and then quietly removes nothing,
// because the buckets' policies scope every object to its owner and this
// script is nobody. Caught here rather than reported as "0 objects".
if (!/"role"\s*:\s*"service_role"/.test(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString())) {
  console.error('That key is not a service_role key. An anon key deletes nothing here.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

/**
 * Every object path under `prefix`, depth-first.
 *
 * Storage has no recursive list: `list()` returns one directory level, and a
 * folder comes back as an entry with a null `id`. Both real prefixes in this
 * project are one level deep (`{uid}/` for avatars and stickers, `{a}_{b}/`
 * for chat-media), but the recursion is here anyway — a listing that silently
 * skipped a level would report success over files it never saw.
 */
async function walk(bucket, prefix = '') {
  const found = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data?.length) break;

    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) found.push(...(await walk(bucket, path)));
      else found.push(path);
    }

    if (data.length < PAGE) break;
  }
  return found;
}

let total = 0;
let failed = false;

for (const bucket of BUCKETS) {
  let paths;
  try {
    paths = await walk(bucket);
  } catch (e) {
    console.error(`${bucket}: ${e.message}`);
    failed = true;
    continue;
  }

  if (!paths.length) {
    console.log(`${bucket}: already empty`);
    continue;
  }

  if (dryRun) {
    console.log(`${bucket}: ${paths.length} object(s) would be removed`);
    for (const p of paths) console.log(`  ${p}`);
    total += paths.length;
    continue;
  }

  let removed = 0;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const batch = paths.slice(i, i + CHUNK);
    const { error } = await supabase.storage.from(bucket).remove(batch);
    if (error) {
      console.error(`${bucket}: remove failed: ${error.message}`);
      failed = true;
      break;
    }
    removed += batch.length;
  }

  console.log(`${bucket}: removed ${removed} of ${paths.length}`);
  total += removed;
}

console.log(
  dryRun
    ? `\n${total} object(s) would go. Re-run without --dry-run.`
    : `\n${total} object(s) removed. Now run reset-data.sql.`
);

// A partial wipe followed by a successful `DELETE FROM auth.users` leaves
// files nobody can reach and no account that could have. Exit non-zero so a
// script running both stops here.
process.exit(failed ? 1 : 0);
