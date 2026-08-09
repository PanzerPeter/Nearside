import { describe, expect, it, vi } from 'vitest';

// Native, so the entitlement half of `ownedPacks` runs rather than short
// circuiting to an empty set and making the merge assertions vacuous.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  SystemBars: { setStyle: async () => undefined },
  SystemBarsStyle: { Light: 'LIGHT', Dark: 'DARK' },
}));

vi.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    getCustomerInfo: async () => ({
      customerInfo: { entitlements: { active: { 'pack.midnight': {} } } },
    }),
  },
}));

const grants: { rows: { pack_id: string }[]; error: { message: string } | null } = {
  rows: [],
  error: null,
};

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: async () => ({ data: grants.rows, error: grants.error }),
    }),
  },
}));

import { readFileSync } from 'node:fs';
import { PACKS } from './purchases';
import { grantedPacks, knownPackIds, ownedPacks } from './theme-grants';

describe('knownPackIds', () => {
  it('keeps rows naming a pack this build ships', () => {
    expect(knownPackIds([{ pack_id: PACKS[0].id }, { pack_id: PACKS[1].id }])).toEqual(
      new Set([PACKS[0].id, PACKS[1].id])
    );
  });

  it('drops a row for a pack that no longer exists', () => {
    // A renamed pack leaves rows behind. They must not become a theme the app
    // believes it owns and can never apply.
    expect(knownPackIds([{ pack_id: 'pack.retired' }])).toEqual(new Set());
  });
});

describe('grantedPacks', () => {
  it('reads the granted packs for the signed-in account', async () => {
    grants.rows = [{ pack_id: 'pack.sakura' }];
    expect(await grantedPacks()).toEqual(new Set(['pack.sakura']));
  });

  it('owns nothing when the query fails', async () => {
    // Cosmetics. A failed read must not stop the appearance screen rendering.
    grants.rows = [];
    grants.error = { message: 'network' };
    expect(await grantedPacks()).toEqual(new Set());
    grants.error = null;
  });
});

describe('ownedPacks', () => {
  it('merges what was bought with what was granted', async () => {
    grants.rows = [{ pack_id: 'pack.sakura' }];
    expect(await ownedPacks()).toEqual(new Set(['pack.midnight', 'pack.sakura']));
  });

  it('does not double count a pack that is both bought and granted', async () => {
    grants.rows = [{ pack_id: 'pack.midnight' }];
    expect(await ownedPacks()).toEqual(new Set(['pack.midnight']));
  });
});

describe('the grant migration', () => {
  it('lists every pack the client ships', () => {
    // `grant_theme_packs(email)` with no ids means "all of them", so the list
    // lives in SQL as well as in `PACKS`. A pack added to the client and not to
    // the migration would silently never reach a showcase account.
    const sql = readFileSync('supabase/migrations/0030_theme_grants.sql', 'utf8');
    const array = sql.slice(sql.indexOf('SELECT ARRAY['), sql.indexOf(']::text[]'));
    for (const pack of PACKS) {
      expect(array).toContain(`'${pack.id}'`);
    }
  });
});
