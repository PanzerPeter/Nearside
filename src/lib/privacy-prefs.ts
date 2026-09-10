// What this account tells other people about itself, beyond what it sends.
//
// Three signals leave a device without anybody typing them: the read watermark,
// the typing broadcast, and presence. Each is useful and none of them was ever
// a choice. These are the choices.
//
// Every one is **symmetric**: turning a signal off stops this device sending it
// *and* stops it showing the peer's. Not as a punishment — because the opposite
// is a one-way mirror, and a product that lets you watch somebody who cannot
// watch you has taken a side. The typing and presence halves are enforced here,
// in the client, which is honest about what it is: they are broadcast-only, so
// there is no stored fact for a server to withhold. The read watermark is a row
// the peer can read, so *that* half is enforced by the database (migration
// 0045, `shares_read()`), because a client-side check on a public repo is one
// anybody can delete.

export interface PrivacyPrefs {
  /** Let peers see how far you have read. Server-enforced; see 0045. */
  readReceipts: boolean;
  /** Broadcast "typing…", and see theirs. */
  typing: boolean;
  /** Publish online/away, and see theirs. */
  presence: boolean;
}

/** Everything on. The app behaved this way before the settings existed, and a
 *  release that quietly turned three signals off would look like a bug to both
 *  sides of every conversation. */
export const DEFAULT_PRIVACY_PREFS: PrivacyPrefs = {
  readReceipts: true,
  typing: true,
  presence: true,
};

export type PrivacyPrefKey = keyof PrivacyPrefs;

/**
 * Read a stored blob back into prefs.
 *
 * Anything unrecognised falls back to the default rather than to `false`: a
 * corrupted or half-written value must not silently switch signals off, which
 * would read to the user as the app having stopped working.
 */
export function parsePrivacyPrefs(raw: string | null): PrivacyPrefs {
  if (!raw) return { ...DEFAULT_PRIVACY_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PRIVACY_PREFS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PRIVACY_PREFS };
  const source = parsed as Record<string, unknown>;
  const next = { ...DEFAULT_PRIVACY_PREFS };
  for (const key of Object.keys(next) as PrivacyPrefKey[]) {
    if (typeof source[key] === 'boolean') next[key] = source[key];
  }
  return next;
}

const PREFS_KEY = 'nearside.privacy.signals';

let cached: PrivacyPrefs | null = null;
const listeners = new Set<() => void>();

export function privacyPrefs(): PrivacyPrefs {
  if (cached) return cached;
  try {
    cached = parsePrivacyPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    // Storage denied. Everything on for this run, which is what the app did
    // before any of this existed.
    cached = { ...DEFAULT_PRIVACY_PREFS };
  }
  return cached;
}

export function setPrivacyPref(key: PrivacyPrefKey, on: boolean): void {
  const next = { ...privacyPrefs(), [key]: on };
  cached = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Applies for this run and is forgotten; the toggle still took effect.
  }
  for (const listener of listeners) listener();
}

/** Set the whole thing at once — used when the server's answer for the read
 *  watermark arrives and disagrees with what this device last cached. */
export function applyPrivacyPrefs(prefs: PrivacyPrefs): void {
  cached = { ...prefs };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(cached));
  } catch {
    // As above.
  }
  for (const listener of listeners) listener();
}

/** Hear about a change. The open thread, the presence provider and the settings
 *  page are siblings; the same shape `subscribeChatFlags` uses. */
export function subscribePrivacyPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget the cached copy so a fresh read hits storage again. */
export function resetPrivacyPrefsCache(): void {
  cached = null;
}
