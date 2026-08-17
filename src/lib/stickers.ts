// A personal sticker library: images you upload once and send as often as you
// like.
//
// The thing to understand before changing anything here is that a sticker has
// two completely separate lives, and they deliberately do not share storage.
//
//   The library — this file. Rows in `stickers`, objects in the `stickers`
//   bucket, sealed under the owner's vault key. Nobody else can open any of it,
//   which is why there is no sharing and no shared-read policy.
//
//   A sticker you sent — an ordinary attachment, indistinguishable from a photo
//   (`useMediaSend`). Fresh per-file key, fresh upload into `chat-media`, key
//   sealed to the recipient on the row.
//
// The cheap design is one upload and a sticker id on the message row. It is
// also the one thing this schema has spent thirty-two migrations refusing to
// do: it would put "who sent which picture to whom, and when" on the server in
// plaintext, for the one message type where the picture *is* the message. So
// sending re-uploads the same small file each time, and that is the feature
// working, not a missing optimisation.
//
// Rows come back **still sealed**, like `message-queries.ts` and
// `sealed-exchange.ts`. Opening happens at the component boundary, which is the
// only layer holding an identity.
import { supabase } from './supabase';
import { openForSelf, sealForSelf } from './crypto/seal';
import { fromBase64, toBase64, type Identity } from './crypto/keys';
import { openFile, sealFile } from './media-crypto';
import { compressImage } from './compress';

/** Stickers are drawn at ~128px and never opened in a lightbox, so anything
 *  past this is bytes nobody sees. Also what keeps a send cheap enough that
 *  re-uploading per send is an acceptable price. */
export const STICKER_MAX_EDGE = 512;

/** Mirrors `file_size_limit` on the bucket in `storage/setup.sql`. Checked here
 *  as well so an oversized file is refused with a sentence instead of a 413
 *  from Storage. The two must not drift. */
export const STICKER_MAX_BYTES = 1_048_576;

export const STICKER_LABEL_MAX = 32;

/** Ceiling on the library. A grid this size already needs scrolling, and every
 *  entry is a row plus an object that sign-out has to clean up. */
export const STICKER_LIMIT = 100;

/**
 * What can be turned into a sticker.
 *
 * An animated source keeps its animation. `compressImage` re-encodes nothing it
 * cannot re-encode without losing frames — GIF by type, animated WebP and APNG
 * by reading the container — and an `<img>` plays all three, so the bubble needs
 * no decode path of its own. The catch is that an animation is not shrunk
 * either, so a large one is refused by `STICKER_MAX_BYTES` rather than squeezed
 * under it.
 */
export const STICKER_SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** A row as stored: the label and the file key are both sealed. */
export interface SealedSticker {
  id: string;
  user_id: string;
  path: string;
  key_ciphertext: string;
  key_nonce: string;
  label_ciphertext: string;
  label_nonce: string;
  sort: number;
  created_at: string;
}

/** A row after the vault key has been over it. `key` is null when this device
 *  cannot open it, which is what a restored-from-phrase mismatch looks like. */
export interface Sticker extends SealedSticker {
  label: string;
  key: Uint8Array | null;
}

const COLUMNS = 'id, user_id, path, key_ciphertext, key_nonce, label_ciphertext, label_nonce, sort, created_at';

/**
 * Where an object lives in the bucket.
 *
 * The first folder segment is the owner's id and the storage policies key off
 * it, so this shape is load-bearing rather than cosmetic. No extension: unlike
 * a chat attachment there is no download filename to preserve, and the bucket
 * accepts one mime type.
 */
export function stickerPath(userId: string, id: string): string {
  return `${userId}/${id}`;
}

/**
 * The name as it will be stored.
 *
 * Collapsed and trimmed because the label is matched against a search box:
 * "  happy   cat " and "happy cat" are the same sticker to a human and should
 * be the same string to the filter.
 */
export function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, STICKER_LABEL_MAX);
}

/** Whether a picked file can become a sticker, and why not when it cannot. */
export function stickerRejection(file: File): string | null {
  if (!STICKER_SOURCE_TYPES.includes(file.type)) {
    return 'Stickers have to be a PNG, JPEG, WebP or GIF.';
  }
  // Checked before compression as a cheap early exit; the post-compression size
  // is what the bucket actually sees and is checked again at upload.
  if (file.size > STICKER_MAX_BYTES * 8) {
    return 'That image is far too large for a sticker.';
  }
  return null;
}

/** Newest last within a sort group, so a freshly added sticker lands at the end
 *  of the grid where the user was just looking. */
export function sortStickers(list: Sticker[]): Sticker[] {
  return [...list].sort(
    (a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  );
}

/** The `sort` value for one appended to the end of a library. */
export function nextSort(list: Pick<Sticker, 'sort'>[]): number {
  return list.reduce((max, s) => Math.max(max, s.sort), 0) + 1;
}

/**
 * Local, case- and accent-insensitive label match.
 *
 * Local because it has to be: the label is sealed, so there is no server-side
 * filter to defer to and the whole library is already in memory by the time a
 * search box can be typed into.
 */
export function matchesLabel(label: string, query: string): boolean {
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const needle = fold(query.trim());
  return needle === '' || fold(label).includes(needle);
}

/** Every sticker this account owns, still sealed. */
export async function listStickers(userId: string): Promise<SealedSticker[]> {
  const { data } = await supabase
    .from('stickers')
    .select(COLUMNS)
    .eq('user_id', userId)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(STICKER_LIMIT);
  return data ?? [];
}

/** Opens the label and the file key of each row under the vault key. A row that
 *  will not open keeps its place with an empty label rather than vanishing —
 *  a sticker the device cannot read is still one the account is storing. */
export async function openStickers(
  identity: Identity,
  rows: SealedSticker[]
): Promise<Sticker[]> {
  return Promise.all(
    rows.map(async (row) => {
      let label = '';
      let key: Uint8Array | null = null;
      try {
        label = await openForSelf(identity.vaultKey, {
          ciphertext: row.label_ciphertext,
          nonce: row.label_nonce,
        });
        key = await fromBase64(
          await openForSelf(identity.vaultKey, {
            ciphertext: row.key_ciphertext,
            nonce: row.key_nonce,
          })
        );
      } catch {
        // Left as ('', null) — see the doc comment.
      }
      return { ...row, label, key };
    })
  );
}

/**
 * Normalise, seal and upload one image, then record it.
 *
 * The object goes up before the row, and the row is what holds the only copy of
 * the file key: an upload whose insert then fails leaves bytes nobody can ever
 * open, so it is cleaned up rather than left to rot in the bucket.
 */
export async function uploadSticker(
  identity: Identity,
  userId: string,
  file: File,
  label: string,
  sort: number
): Promise<Sticker> {
  const shrunk = await compressImage(file, { maxEdge: STICKER_MAX_EDGE });
  const bytes = new Uint8Array(await shrunk.arrayBuffer());
  if (bytes.byteLength > STICKER_MAX_BYTES) {
    throw new Error('That image is still too large after shrinking.');
  }

  const { blob, key } = await sealFile(bytes);
  const id = crypto.randomUUID();
  const path = stickerPath(userId, id);

  const { error: uploadError } = await supabase.storage
    .from('stickers')
    .upload(path, blob, { contentType: blob.type, upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  const [sealedKey, sealedLabel] = await Promise.all([
    sealForSelf(identity.vaultKey, await toBase64(key)),
    sealForSelf(identity.vaultKey, normalizeLabel(label)),
  ]);

  const { data, error } = await supabase
    .from('stickers')
    .insert({
      id,
      user_id: userId,
      path,
      key_ciphertext: sealedKey.ciphertext,
      key_nonce: sealedKey.nonce,
      label_ciphertext: sealedLabel.ciphertext,
      label_nonce: sealedLabel.nonce,
      sort,
    })
    .select(COLUMNS)
    .single();

  if (error || !data) {
    // Without the row there is no key, so these bytes are already unopenable.
    // Removing them keeps the bucket from filling with objects that cannot be
    // reached from anywhere.
    await supabase.storage.from('stickers').remove([path]);
    throw new Error(error?.message ?? 'Could not save that sticker.');
  }

  return { ...data, label: normalizeLabel(label), key };
}

/** Rename. The label is sealed, so this is a re-seal rather than a text update. */
export async function renameSticker(
  identity: Identity,
  id: string,
  label: string
): Promise<string> {
  const clean = normalizeLabel(label);
  const sealed = await sealForSelf(identity.vaultKey, clean);
  await supabase
    .from('stickers')
    .update({ label_ciphertext: sealed.ciphertext, label_nonce: sealed.nonce })
    .eq('id', id);
  return clean;
}

/**
 * Delete a sticker from the library.
 *
 * Row first: it holds the only copy of the file key, so once it is gone the
 * object is unopenable whatever happens next. The reverse order would leave a
 * window where the row points at bytes that are no longer there, which renders
 * as a broken tile.
 */
export async function deleteSticker(id: string, path: string): Promise<void> {
  await supabase.from('stickers').delete().eq('id', id);
  await supabase.storage.from('stickers').remove([path]);
}

/** Fetch and open one sticker's bytes. The caller caches; this does not. */
export async function stickerBytes(sticker: Sticker): Promise<Uint8Array | null> {
  if (!sticker.key) return null;
  const { data } = await supabase.storage.from('stickers').download(sticker.path);
  if (!data) return null;
  try {
    return await openFile(new Uint8Array(await data.arrayBuffer()), sticker.key);
  } catch {
    return null;
  }
}

/**
 * The image type of decrypted bytes, read from their magic number.
 *
 * Sniffed rather than remembered because nothing records it: the object is
 * uploaded as `application/octet-stream` (the bucket accepts nothing else), and
 * `compressImage` hands back the *original* file whenever WebP would be larger
 * or the encoder is missing — so a sticker's real type is decided at upload time
 * and is not always what the compressor was asked for. Guessing 'image/webp'
 * here would mislabel exactly those files.
 *
 * Falls back to a blank type rather than a wrong one. `<img>` sniffs its own
 * bytes, so a blob with no type still renders; a blob claiming the wrong one is
 * what breaks it.
 */
export function imageMimeFromBytes(bytes: Uint8Array): string {
  const at = (i: number) => bytes[i];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  // RIFF....WEBP — the four size bytes in between are why this is not one span.
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

/**
 * Object URLs for stickers already fetched and opened, keyed by sticker id.
 *
 * Module-level rather than inside the hook, because the picker unmounts every
 * time it closes. A cache owned by the component would re-download and
 * re-decrypt the entire drawer on each open, which is the difference between a
 * grid that appears and a grid that loads.
 *
 * Per-account like every other cache in the app — see `forgetStickers`.
 */
const objectUrls = new Map<string, string>();

/** A displayable URL for a sticker, fetched and decrypted once. */
export async function stickerUrl(sticker: Sticker): Promise<string | null> {
  const cached = objectUrls.get(sticker.id);
  if (cached) return cached;
  const bytes = await stickerBytes(sticker);
  if (!bytes) return null;
  // Copied into a fresh array: `openFile` hands back a view whose buffer is
  // typed as possibly shared, which is not a `BlobPart`. A sticker is under a
  // megabyte, so the copy is free.
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: imageMimeFromBytes(bytes) })
  );
  objectUrls.set(sticker.id, url);
  return url;
}

/**
 * A sticker as a `File`, ready to be sent as an ordinary attachment.
 *
 * Reads back through the object URL rather than downloading again: the drawer
 * has already fetched and decrypted this sticker to draw the tile the user just
 * tapped, and `fetch` on a blob: URL is a memory read. Sending is a fresh seal
 * and a fresh upload no matter what — that is the design — but it does not have
 * to be a fresh download too.
 */
export async function stickerFile(sticker: Sticker): Promise<File | null> {
  const url = await stickerUrl(sticker);
  if (!url) return null;
  const blob = await fetch(url).then((r) => r.blob());
  const extension = (blob.type.split('/')[1] || 'webp').replace('jpeg', 'jpg');
  return new File([blob], `${sticker.id}.${extension}`, { type: blob.type });
}

/** Drop one sticker's cached bytes — after a delete, so a re-added sticker with
 *  a recycled id cannot show the old picture. */
export function forgetSticker(id: string): void {
  const url = objectUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(id);
}

/**
 * Drop every cached sticker.
 *
 * Belongs in the sign-out and account-switch teardown: these are decrypted
 * images held in memory under the previous account's vault key, and CLAUDE.md's
 * rule is that a new per-account cache is added to that chain or it leaks into
 * the next account on the device.
 */
export function forgetStickers(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
