// Keeping an attachment forever, on this phone, for free.
//
// Server-side pruning exists because Supabase storage is finite, not because
// storage is a product. Nothing is sold back to the user here: a pin downloads
// the object, opens it with the same file key the bubble already used, and
// writes the plaintext into app-private storage. The server copy then prunes on
// the ordinary schedule and the pinned copy outlives it at no cost.
//
// App-private, not the gallery: `Directory.Data` is inside the app's sandbox,
// which no other app and no media scanner can read. Saving to the gallery is a
// separate, deliberate action the user takes in the viewer — a pin is about
// keeping something in Nearside, not about publishing it to the phone.
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { allPins, cachedPin, pinnedIds, putPin, removePin } from './localdb';
import { mimeForPath } from './media';
import type { MediaType } from './types';

/** Where pinned plaintext lives inside the sandbox. */
const PIN_DIR = 'pins';

export { pinnedIds };

function pinPath(messageId: string, objectPath: string): string {
  const ext = objectPath.split('.').pop();
  // Named for the message, not the object: two forwards of the same file share
  // an object path, and one being unpinned would delete the other's bytes.
  return `${PIN_DIR}/${messageId}${ext && ext !== objectPath ? `.${ext}` : ''}`;
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
  bytes: Uint8Array
): Promise<void> {
  const path = pinPath(messageId, objectPath);

  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({
      path,
      data: toBase64(bytes),
      directory: Directory.Data,
      recursive: true,
    });
  }

  await putPin({ message_id: messageId, file_path: path, pinned_at: new Date().toISOString() });
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
  if (!pin || !Capacitor.isNativePlatform()) return null;

  try {
    const { data } = await Filesystem.readFile({ path: pin.file_path, directory: Directory.Data });
    const bytes = fromBase64(typeof data === 'string' ? data : await data.text());
    return URL.createObjectURL(
      new Blob([bytes.slice()], { type: mimeForPath(pin.file_path, kind) })
    );
  } catch {
    // The row outlived the file — a cleared cache, or a restore that did not
    // carry the sandbox. Drop the row so the UI stops promising a copy it does
    // not have.
    await removePin(messageId);
    return null;
  }
}

/**
 * Delete every pinned file this account kept, and the rows naming them.
 *
 * Called before `clearLocalDb` on sign-out and on account deletion, and the
 * order matters: the rows are the only record of where the files are, so
 * clearing the store first would strand decrypted photos and voice notes in
 * the sandbox with nothing left able to find them. That is what used to
 * happen — `clearLocalDb` dropped the `pins` table's rows and the plaintext
 * they pointed at outlived both the sign-out and the deleted account.
 *
 * Best effort per file: one that cannot be removed must not stop the rest, and
 * neither may stop a sign-out.
 */
export async function clearPinnedMedia(): Promise<void> {
  const pins = await allPins();
  for (const pin of pins) {
    if (Capacitor.isNativePlatform()) {
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
  if (pin && Capacitor.isNativePlatform()) {
    await Filesystem.deleteFile({ path: pin.file_path, directory: Directory.Data }).catch(() => {});
  }
}
