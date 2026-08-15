import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `supabase/maintenance/reset-data.sql` wipes a demo project by deleting
// `auth.users` and letting the cascade do the rest, then counts every table to
// prove nothing survived. That proof is only worth anything while it names
// every table there is — a table added later and not added there would be
// wiped silently if it cascades, and left full of a deleted account's rows if
// it does not, with the script still printing all zeros either way.
//
// So the list is checked against schema.sql, which is the one file that
// describes the whole database.
const SCHEMA = 'supabase/schema.sql';
const RESET = 'supabase/maintenance/reset-data.sql';

/**
 * Tables the reset deliberately does not count.
 *
 * `push_config` holds the push function's URL and trigger secret. It is
 * configuration, it has no foreign key to a user, and the wipe leaves it in
 * place on purpose — deleting it turns push notifications off for whoever
 * signs up next, silently, because the trigger just returns when the row is
 * missing.
 */
const NOT_USER_DATA = new Set(['push_config']);

function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map((m) => m[1]);
}

describe('reset-data.sql', () => {
  it('accounts for every table in schema.sql', () => {
    if (!existsSync(SCHEMA) || !existsSync(RESET)) return;
    const reset = readFileSync(RESET, 'utf8');
    const missing = tablesIn(readFileSync(SCHEMA, 'utf8')).filter(
      (t) => !NOT_USER_DATA.has(t) && !reset.includes(`public.${t}`)
    );
    expect(missing).toEqual([]);
  });

  it('never tries to delete storage rows in SQL', () => {
    if (!existsSync(RESET)) return;
    const reset = readFileSync(RESET, 'utf8');
    // `storage.protect_delete()` raises on a direct DELETE from a storage
    // table, and the SQL editor runs a script as one transaction — so a
    // DELETE here does not merely fail, it rolls back the `auth.users` wipe
    // beside it and the whole reset silently does nothing. The buckets are
    // emptied through the Storage API first, by empty-buckets.mjs.
    //
    // Statements only: the file explains the refusal in prose, and the prose
    // is the reason this rule survives.
    const statements = reset.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
    expect(statements).not.toMatch(/DELETE\s+FROM\s+storage\./i);
    expect(statements).toContain('DELETE FROM auth.users');
  });

  it('points at the script that does the part SQL cannot', () => {
    if (!existsSync(RESET)) return;
    expect(readFileSync(RESET, 'utf8')).toContain('empty-buckets.mjs');
  });
});
