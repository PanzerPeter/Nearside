// The stickers this device reached for most recently.
//
// A drawer of a hundred is four tiles wide, so the one somebody sends twenty
// times a day is three scrolls down by the end of the week. Reordering by hand
// exists (`sort`, written to the server) and is the right tool for arranging a
// library; this is the other half — the shelf that arranges itself.
//
// **Local to the device and never uploaded.** Which stickers you send most
// often, and how often, is a behavioural profile, and the reason this app keeps
// no such profile on the server is the same reason it holds no message bodies
// there. `localStorage` is the right home for it: per device, per browser
// profile, and gone when the app's data is cleared.
//
// Keyed per account, because the drawer is: a sticker id belongs to one
// account's rows, and a device-wide list would be one account's habits sitting
// in another's picker.

/** How many are remembered. One row of the four-wide grid, twice over: enough
 *  that the shelf is useful, few enough that it does not become a second copy
 *  of the library above the library. */
export const RECENT_LIMIT = 8;

const PREFIX = 'nearside.stickers.recent.';

/**
 * `id` moved to the front, with any earlier appearance removed and the tail
 * trimmed.
 *
 * Pure, and separate from the storage below, because the ordering is the part
 * worth proving: a "recent" list that can hold the same sticker twice has a
 * duplicate tile in it, and one that grows without a cap eventually *is* the
 * library.
 */
export function promoteRecent(
  ids: readonly string[],
  id: string,
  limit = RECENT_LIMIT
): string[] {
  return [id, ...ids.filter((existing) => existing !== id)].slice(0, limit);
}

function key(userId: string): string {
  return PREFIX + userId;
}

/**
 * The remembered ids, newest first.
 *
 * Every read is guarded: `localStorage` throws outright in a private window on
 * some browsers and returns nothing in a WebView with site data blocked, and a
 * picker that will not open because a convenience feature could not read its
 * preferences is a bad trade.
 */
export function recentStickerIds(userId: string | null): string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Record that a sticker was sent, and answer with the new list so the caller
 *  can render it without a second read. */
export function recordStickerUse(userId: string | null, id: string): string[] {
  if (!userId) return [];
  const next = promoteRecent(recentStickerIds(userId), id);
  try {
    localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Out of quota, or storage is off. The shelf is a convenience and its
    // failure is not worth a word to anybody.
  }
  return next;
}

/** Drop the whole list — part of what signing out of an account clears. */
export function forgetStickerRecents(userId: string | null): void {
  if (!userId) return;
  try {
    localStorage.removeItem(key(userId));
  } catch {
    // See above.
  }
}

/**
 * The recent ids resolved against the library, in recency order.
 *
 * An id whose sticker is gone — deleted from another device, or never loaded
 * here — is dropped rather than drawn as a hole. The list itself is left alone:
 * rewriting storage from a render is how a library that is still loading
 * quietly empties the shelf.
 */
export function resolveRecents<T extends { id: string }>(
  ids: readonly string[],
  library: readonly T[]
): T[] {
  const byId = new Map(library.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is T => !!item);
}
