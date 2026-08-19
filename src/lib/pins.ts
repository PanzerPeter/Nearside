// Keeping an attachment forever, on this phone, for free.
//
// Server-side pruning exists because Supabase storage is finite, not because
// storage is a product. Nothing is sold back to the user here: a pin downloads
// the object, opens it with the same file key the bubble already used, and
// writes the plaintext into app-private storage. The server copy then prunes on
// the ordinary schedule and the pinned copy outlives it at no cost.
//
// App-private rather than the gallery. `Directory.Data` sits inside the app's
// sandbox, which no other app and no media scanner can read. Saving to the
// gallery is a separate action the user takes in the viewer: a pin keeps
// something in Nearside without publishing it to the phone.
import { Directory, Filesystem } from '@capacitor/filesystem';
import { allPins, cachedPin, pinnedIds, putPin, removePin, type PinnedMedia } from './localdb';
import { mimeForPath } from './media';
import type { MediaType } from './types';
import { isMobileNative } from './platform';

/** Where pinned plaintext lives inside the sandbox. */
const PIN_DIR = 'pins';

export { pinnedIds };

/*
 * The pins this account holds, in memory, so the thread can ask about every
 * message it renders without a query per bubble.
 *
 * It exists for `lib/pin-restore.ts`: a row the sender has trimmed arrives from
 * the server with no media columns at all, so "is there a pin for this id"
 * has to be answerable while rendering, synchronously, for rows that look like
 * ordinary text. Kept as a whole `Map` replaced on every change rather than
 * mutated, because `useSyncExternalStore` compares snapshots by identity.
 */
const EMPTY: ReadonlyMap<string, PinnedMedia> = new Map();
let snapshot: ReadonlyMap<string, PinnedMedia> = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, PinnedMedia>): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

function withPin(row: PinnedMedia): void {
  publish(new Map(snapshot).set(row.message_id, row));
}

function withoutPin(messageId: string): void {
  if (!snapshot.has(messageId)) return;
  const next = new Map(snapshot);
  next.delete(messageId);
  publish(next);
}

/** Fill the index from this account's store. Cheap and idempotent — there is
 *  one row per pinned attachment — so every reader may call it on mount. */
export async function loadPins(): Promise<void> {
  const rows = await allPins();
  loaded = true;
  publish(new Map(rows.map((row) => [row.message_id, row])));
}

/** True once the store has answered. Until then the snapshot is empty for the
 *  ordinary reason (no pins) and for the misleading one (not read yet), and a
 *  caller that must not act on the difference can tell them apart. */
export function pinsLoaded(): boolean {
  return loaded;
}

export function pinsSnapshot(): ReadonlyMap<string, PinnedMedia> {
  return snapshot;
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop the index on sign-out and on an account switch. The pins themselves
 *  live in the account's own store; what must not survive is this copy, which
 *  would otherwise answer the next account's thread with the last one's
 *  message ids. Every per-account cache belongs in `releaseAccount`. */
export function forgetPinIndex(): void {
  loaded = false;
  publish(EMPTY);
}

function pinPath(messageId: string, objectPath: string): string {
  // Read off the last segment, not the whole path: a dot anywhere in a folder
  // name would otherwise be taken for the extension of a file that has none.
  const name = objectPath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  // Named for the message, not the object: two forwards of the same file share
  // an object path, and one being unpinned would delete the other's bytes.
  return `${PIN_DIR}/${messageId}${ext ? `.${ext}` : ''}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on
  // anything larger than a small image, which is most of what gets pinned.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function isPinned(messageId: string): Promise<boolean> {
  return (await cachedPin(messageId)) !== null;
}

/** What the message row held when the pin was made, so a row the server has
 *  since emptied can be rendered from the kept bytes. */
export interface PinnedFrom {
  mediaType: MediaType;
  /** The message's body at that moment — '' for a picture sent with nothing
   *  written under it. The trim replaces it with a placeholder, and this is
   *  the only copy left. */
  caption: string;
}

/**
 * Writes already-decrypted bytes to app-private storage and records the pin.
 *
 * Takes plaintext rather than fetching and opening the object itself: every
 * caller is a bubble that has already done both, and doing it twice would mean
 * a second download and a second decrypt of a file that is on screen.
 */
export async function pinMedia(
  messageId: string,
  objectPath: string,
  bytes: Uint8Array,
  from: PinnedFrom
): Promise<void> {
  const path = pinPath(messageId, objectPath);

  if (isMobileNative()) {
    await Filesystem.writeFile({
      path,
      data: toBase64(bytes),
      directory: Directory.Data,
      recursive: true,
    });
  }

  const row = {
    message_id: messageId,
    file_path: path,
    pinned_at: new Date().toISOString(),
    // Copied off the row rather than looked up later: by the time it matters
    // the server row has been stripped of all three.
    media_path: objectPath,
    media_type: from.mediaType,
    caption: from.caption,
  };
  await putPin(row);
  withPin(row);
}

/**
 * An object URL for the pinned copy, or null if there is no pin or the file has
 * gone. The caller owns the URL and must revoke it.
 */
export async function pinnedObjectUrl(
  messageId: string,
  kind?: MediaType | null
): Promise<string | null> {
  const pin = await cachedPin(messageId);
  if (!pin || !isMobileNative()) return null;

  try {
    const { data } = await Filesystem.readFile({ path: pin.file_path, directory: Directory.Data });
    const bytes = fromBase64(typeof data === 'string' ? data : await data.text());
    return URL.createObjectURL(
      new Blob([bytes.slice()], { type: mimeForPath(pin.file_path, kind) })
    );
  } catch {
    // The row outlived the file — a cleared cache, or a restore that did not
    // carry the sandbox. Drop the row so the UI stops promising a copy it does
    // not have, and drop it from the index too: left there, `restorePinned`
    // would go on rebuilding a bubble around bytes that are not coming.
    await removePin(messageId);
    withoutPin(messageId);
    return null;
  }
}

/**
 * The size of every pinned file, in pin order, for the storage screen.
 *
 * `null` where the file could not be stat'd — the row survived and the bytes
 * did not, which `totalPinBytes` reports as unmeasured rather than as nothing.
 * Nothing is deleted here on a miss: unlike `pinnedObjectUrl`, which is a user
 * asking to open one file, this is a readout of all of them, and a screen that
 * silently prunes rows while showing you a total is not a readout.
 */
export async function pinnedFileSizes(): Promise<(number | null)[]> {
  const pins = await allPins();
  if (!isMobileNative()) return pins.map(() => null);
  return Promise.all(
    pins.map(async (pin) => {
      try {
        const { size } = await Filesystem.stat({ path: pin.file_path, directory: Directory.Data });
        return size;
      } catch {
        return null;
      }
    })
  );
}

/**
 * Delete every pinned file this account kept, and the rows naming them.
 *
 * Called before `clearLocalDb` on sign-out and on account deletion, and the
 * order matters. The rows are the only record of where the files are, so
 * dropping the `pins` table first strands decrypted photos and voice notes in
 * the sandbox, outliving both the sign-out and the deleted account.
 *
 * Best effort per file: one that cannot be removed must not stop the rest, and
 * neither may stop a sign-out.
 */
export async function clearPinnedMedia(): Promise<void> {
  const pins = await allPins();
  publish(EMPTY);
  for (const pin of pins) {
    if (isMobileNative()) {
      await Filesystem.deleteFile({ path: pin.file_path, directory: Directory.Data }).catch(
        () => {}
      );
    }
    await removePin(pin.message_id);
  }
}

export async function unpinMedia(messageId: string): Promise<void> {
  const pin = await cachedPin(messageId);
  await removePin(messageId);
  withoutPin(messageId);
  if (pin && isMobileNative()) {
    await Filesystem.deleteFile({ path: pin.file_path, directory: Directory.Data }).catch(() => {});
  }
}
