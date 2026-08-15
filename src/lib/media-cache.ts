// Decrypted attachments, kept for as long as the session holds them.
//
// A signed URL carries a fresh JWT in its query string, so no two signatures of
// the same object are the same string and the HTTP cache can never hit. Nothing
// else held the bytes either: scrolling an image out of the thread unmounted
// its component, which revoked the blob, and scrolling back downloaded and
// decrypted the whole file again. Opening the viewer over a thumbnail did the
// same thing a second time, for a file already in memory two components away.
//
// So the object URL is owned here rather than by whichever component happened
// to ask first, and `useSignedMediaUrl` reads through this on the way to
// Storage.
//
// In memory only, deliberately. Writing decrypted attachments to disk would
// outlive both the disappearing-message sweep (`lib/disappearing.ts`) and the
// server-side prune that `lib/pins.ts` exists to opt out of, which is a
// different feature with a different consent story — a pin is something the
// user asked for. This cache dies with the session and with the account, like
// the sticker cache it is modelled on.

/** Ceiling on what is held. Passed a decrypted video or two this fills quickly,
 *  which is why eviction is least-recently-used rather than newest-wins: the
 *  attachments on screen are the ones being read. */
export const MEDIA_CACHE_MAX_BYTES = 96 * 1024 * 1024;

export interface CacheEntry {
  /** Storage object path — the cache key, and stable across signatures. */
  path: string;
  bytes: number;
}

/**
 * Which entries have to go for `incoming` to fit, oldest use first.
 *
 * Split out and pure because it is the only part of this module with a decision
 * in it, and the rest is `URL.createObjectURL`, which a node test has no
 * business owning. `entries` is least-recently-used first.
 *
 * An incoming object larger than the whole cap evicts everything and is still
 * returned by the caller — refusing to cache it would be right on the memory
 * ledger and wrong for the user, whose next scroll would download it again.
 */
export function selectEvictions(
  entries: readonly CacheEntry[],
  incoming: number,
  cap: number = MEDIA_CACHE_MAX_BYTES
): string[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0) + incoming;
  if (total <= cap) return [];

  const doomed: string[] = [];
  for (const entry of entries) {
    if (total <= cap) break;
    doomed.push(entry.path);
    total -= entry.bytes;
  }
  return doomed;
}

interface Held {
  url: string;
  bytes: number;
}

// Insertion order is the LRU order: `get` deletes and re-sets a hit, which
// moves it to the end.
const held = new Map<string, Held>();

/** The cached object URL for `path`, marking it as most recently used. */
export function cachedMedia(path: string): string | null {
  const hit = held.get(path);
  if (!hit) return null;
  held.delete(path);
  held.set(path, hit);
  return hit.url;
}

/**
 * Cache decrypted bytes and hand back a URL for them.
 *
 * The URL belongs to this module: callers must not revoke it, because the
 * thumbnail, the viewer opened over it and the same photo forwarded into
 * another conversation are all reading the one blob. An eviction revokes it
 * while something may still be pointing at it, which paints as a broken
 * element and fires the caller's `onError` — the retry that already exists for
 * an expired signature covers it, at the cost of one re-download.
 */
export function putMedia(path: string, blob: Blob): string {
  // A re-sign after an expiry lands on a key that is already held. Dropping it
  // first is what revokes the superseded blob; overwriting the map entry alone
  // leaks it for the life of the session.
  forgetMedia(path);

  for (const doomed of selectEvictions(
    [...held].map(([p, h]) => ({ path: p, bytes: h.bytes })),
    blob.size
  )) {
    forgetMedia(doomed);
  }

  const url = URL.createObjectURL(blob);
  held.set(path, { url, bytes: blob.size });
  return url;
}

/** Drop one object — after a delete, or on eviction. */
export function forgetMedia(path: string): void {
  const hit = held.get(path);
  if (!hit) return;
  URL.revokeObjectURL(hit.url);
  held.delete(path);
}

/**
 * Drop everything.
 *
 * Belongs in the sign-out and account-switch teardown, with `forgetStickers`
 * and the key caches: these are decrypted attachments from the conversations of
 * the account being left.
 */
export function forgetAllMedia(): void {
  for (const hit of held.values()) URL.revokeObjectURL(hit.url);
  held.clear();
}

/** Bytes currently held. Exported for the settings/storage readout and for
 *  tests that need to see eviction happen. */
export function mediaCacheBytes(): number {
  let total = 0;
  for (const hit of held.values()) total += hit.bytes;
  return total;
}
