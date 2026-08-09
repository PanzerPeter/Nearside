// Packs an account owns without having bought them.
//
// RevenueCat is the record of what was paid for, and it is the only one — which
// leaves no way to put every theme in front of a reviewer, a screenshot run or
// a demo phone short of paying six times on each of them. `theme_grants`
// (migration `0030`) is that way: rows a human writes in the SQL editor, read
// back here and merged with the entitlements.
//
// The client can only read. There is no insert path from the app, and the
// granting function is revoked from `authenticated`, because a pack the client
// can award itself is a pack nobody needs to buy.
import { PACKS, packsFromEntitlements } from './purchases';
import { supabase } from './supabase';

/** Grant rows that name a pack this build actually ships. A row for a pack id
 *  we have never heard of — a renamed pack, a typo in the SQL editor — is
 *  dropped rather than carried around as a theme that can never apply. */
export function knownPackIds(rows: { pack_id: string }[]): Set<string> {
  const known = new Set(PACKS.map((p) => p.id));
  return new Set(rows.map((r) => r.pack_id).filter((id) => known.has(id)));
}

/**
 * The packs granted to the signed-in account. RLS scopes the read to their own
 * rows, so there is no filter to get wrong here.
 *
 * Empty on any failure. Owning nothing is the ordinary case, and a store that
 * cannot render because a cosmetic query timed out is worse than one that
 * briefly under-reports.
 */
export async function grantedPacks(): Promise<Set<string>> {
  try {
    const { data, error } = await supabase.from('theme_grants').select('pack_id');
    if (error) return new Set();
    return knownPackIds((data ?? []) as { pack_id: string }[]);
  } catch {
    return new Set();
  }
}

/**
 * Everything the account owns, bought or granted.
 *
 * The two sources are independent and neither is authoritative alone: the
 * entitlements are empty in the browser build and on a phone with no Play
 * services, and the grants are empty for every paying user. This is what the
 * store and `themeForOwnership` should ask.
 */
export async function ownedPacks(): Promise<Set<string>> {
  const [bought, granted] = await Promise.all([packsFromEntitlements(), grantedPacks()]);
  return new Set([...bought, ...granted]);
}
