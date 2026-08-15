// The roster of accounts signed in on this device, and the refresh tokens that
// let one be re-entered without typing a password.
//
// This is the one store in the app that is deliberately device-wide rather than
// per-account. Everything else — the seed (`keystore.ts`), the decrypted mirror
// (`localdb.ts`), the lock verifier (`app-lock.ts`) — is filed under a user id
// and unreadable while a different account is open. A list whose whole job is to
// name the accounts you could switch to cannot itself be locked inside one of
// them.
//
// What it holds is a refresh token, never a seed and never an access token. The
// seed stays in its own Keystore slot, untouched by a switch; the access token
// is minutes old by the time anyone reads this and is exchanged for a fresh one
// anyway. So the roster's blast radius is "sessions this device could already
// resume" — which is what `persistSession: true` already grants for one account.
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

/** One switchable account. `refresh_token` rotates; see `rememberAccount`. */
export interface StoredAccount {
  userId: string;
  display_name: string;
  avatar_url: string | null;
  refresh_token: string;
  /** Epoch ms. Orders the list and decides who falls off the end at MAX. */
  last_used_at: number;
}

const ROSTER_KEY = 'nearside.accounts';

/**
 * Ceiling on stored accounts.
 *
 * Not a product limit anybody asked for — a bound on how many resumable
 * sessions one stolen device yields. Past a handful the list also stops being a
 * switcher and becomes a menu.
 */
export const MAX_ACCOUNTS = 5;

/**
 * Reads a roster back out of storage, dropping anything malformed.
 *
 * Tolerant on purpose. This is a JSON blob under a single key, so one entry
 * written by an older build — or truncated by a kill mid-write — must not cost
 * the user every other account on the device. A dropped entry means one extra
 * sign-in; a thrown parse error means the switcher is empty and there is no way
 * back to any of them.
 */
export function parseRoster(raw: string | null): StoredAccount[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: StoredAccount[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.userId !== 'string' || !e.userId) continue;
    if (typeof e.refresh_token !== 'string' || !e.refresh_token) continue;
    // A duplicate id would render two rows that switch to the same account and
    // disagree about which is current.
    if (seen.has(e.userId)) continue;
    seen.add(e.userId);
    out.push({
      userId: e.userId,
      display_name: typeof e.display_name === 'string' ? e.display_name : '',
      avatar_url: typeof e.avatar_url === 'string' ? e.avatar_url : null,
      refresh_token: e.refresh_token,
      last_used_at: typeof e.last_used_at === 'number' ? e.last_used_at : 0,
    });
  }
  return sortRoster(out);
}

/** Most recently used first, with a stable tiebreak so two entries stamped in
 *  the same millisecond don't swap places between renders. */
export function sortRoster(list: StoredAccount[]): StoredAccount[] {
  return [...list].sort((a, b) => b.last_used_at - a.last_used_at || a.userId.localeCompare(b.userId));
}

/**
 * Adds or replaces an entry, then trims to `MAX_ACCOUNTS`.
 *
 * Replacement is by user id and total: the refresh token is the field that
 * changes most often (Supabase rotates it on every refresh) and a merge that
 * kept the old one would store a token already spent, so the switch it exists
 * for would fail at the moment it is needed.
 *
 * The account being written is exempt from the trim, structurally rather than
 * by trusting its timestamp. It is the account somebody is signed into at this
 * moment; dropping it because a clock skewed or a caller passed a stale stamp
 * would erase the only entry we are certain is live.
 */
export function upsertAccount(list: StoredAccount[], entry: StoredAccount): StoredAccount[] {
  const rest = sortRoster(list.filter((a) => a.userId !== entry.userId));
  return sortRoster([entry, ...rest.slice(0, MAX_ACCOUNTS - 1)]);
}

export function removeAccount(list: StoredAccount[], userId: string): StoredAccount[] {
  return list.filter((a) => a.userId !== userId);
}

/**
 * The accounts offered as switch targets, given who is signed in now.
 *
 * The current account is excluded rather than rendered with a checkmark and
 * made inert: the row's whole affordance is "tap to switch", and one that does
 * nothing when tapped is a bug report. The caller shows the current account
 * separately, where its name is already on screen.
 */
export function switchTargets(list: StoredAccount[], currentUserId: string | null): StoredAccount[] {
  return sortRoster(list).filter((a) => a.userId !== currentUserId);
}

async function readRaw(): Promise<string | null> {
  try {
    const { value } = await SecureStoragePlugin.get({ key: ROSTER_KEY });
    return value ?? null;
  } catch {
    // The plugin throws rather than returning null when the key is absent,
    // which is the ordinary first-launch case.
    return null;
  }
}

async function writeRaw(list: StoredAccount[]): Promise<void> {
  await SecureStoragePlugin.set({ key: ROSTER_KEY, value: JSON.stringify(list) });
}

export async function loadAccounts(): Promise<StoredAccount[]> {
  return parseRoster(await readRaw());
}

/**
 * Records the signed-in account so it can be switched back to later.
 *
 * Call this whenever the refresh token changes, not only at sign-in. Supabase
 * rotates the token on every refresh and invalidates the one it replaced, so a
 * roster written once at sign-in holds a token that is spent within the hour —
 * and the failure only surfaces much later, when someone tries to switch back
 * and is asked to sign in instead.
 */
export async function rememberAccount(entry: Omit<StoredAccount, 'last_used_at'>): Promise<void> {
  const list = await loadAccounts();
  await writeRaw(upsertAccount(list, { ...entry, last_used_at: Date.now() }));
}

/** Drops one account from the switcher. The caller is responsible for the rest
 *  of that account's device state — see `App.forgetAccountFully`. */
export async function forgetAccount(userId: string): Promise<void> {
  const list = await loadAccounts();
  await writeRaw(removeAccount(list, userId));
}

/** The stored refresh token for an account, or null if it is not on the roster. */
export async function accountToken(userId: string): Promise<string | null> {
  const list = await loadAccounts();
  return list.find((a) => a.userId === userId)?.refresh_token ?? null;
}
