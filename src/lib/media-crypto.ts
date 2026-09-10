// Standard build, not -sumo. Plan 2 deliberately swapped away from the sumo
// build to halve the WASM shipped in the APK, and crypto_secretbox is in the
// standard one — reaching for -sumo here would quietly undo that.
import sodium from 'libsodium-wrappers';

/**
 * How much bigger a file gets when it is sealed: a 24-byte nonce in front and
 * a 16-byte authentication tag inside the box.
 *
 * It matters because the bucket's size limit applies to what is *uploaded*, so
 * a file staged at exactly the limit is over it by the time it goes up — and
 * the sender finds out from the server, after the whole upload has been spent.
 */
export const SEAL_OVERHEAD_BYTES = 24 + 16;

/** The nonce is prepended to the ciphertext rather than stored beside it:
 *  a file is one opaque object in Storage, and splitting its nonce into a
 *  database column would mean a row and an object that can drift apart. */
export async function sealFile(bytes: Uint8Array): Promise<{ blob: Blob; key: Uint8Array }> {
  await sodium.ready;
  const key = sodium.crypto_secretbox_keygen();
  return { blob: await sealFileWith(bytes, key), key };
}

/**
 * Seal under a key the caller already has.
 *
 * For the thumbnail (`lib/thumbnail.ts`), which is a second object belonging to
 * an attachment that has already been sealed. It reuses that attachment's key
 * deliberately: the people who may open the picture are exactly the people who
 * may open its preview, so a second key would be a second thing to seal into
 * the row, a second way for a message to be half-readable, and no additional
 * secrecy at all.
 *
 * A fresh nonce every call, which is the part that must not be shared. Two
 * different plaintexts sealed under one key AND one nonce is the failure mode
 * `crypto_secretbox` cannot survive, and it is why this takes only the key.
 */
export async function sealFileWith(bytes: Uint8Array, key: Uint8Array): Promise<Blob> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const sealed = sodium.crypto_secretbox_easy(bytes, nonce, key);

  // Two parts rather than one concatenated array. A Blob keeps a reference to
  // each part instead of flattening them, so the alternative — allocating
  // `nonce.length + sealed.length` and copying the ciphertext into it — is one
  // more copy of the whole file, on a path that is already holding the plain
  // bytes, libsodium's heap copy and the ciphertext at once. On a 50 MB video
  // in a WebView that copy is the difference between sending and being killed.
  //
  // application/octet-stream, always: a sealed JPEG announced as image/jpeg
  // tells anyone reading the bucket what it is.
  //
  // The cast is libsodium's type, not a claim about the data: it declares its
  // output over `ArrayBufferLike`, which TypeScript will not accept as a
  // `BlobPart` because that union admits a SharedArrayBuffer. It is never one
  // here, and satisfying the checker honestly would mean copying the whole
  // ciphertext to change nothing but its type — the copy this is avoiding.
  const parts = [nonce, sealed] as unknown as BlobPart[];
  return new Blob(parts, { type: 'application/octet-stream' });
}

export async function openFile(bytes: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const n = sodium.crypto_secretbox_NONCEBYTES;
  // `subarray`, not `slice`: both hand libsodium a view of the right bytes, and
  // only one of them duplicates the entire ciphertext first. libsodium copies
  // what it is given into its own heap either way, so the intermediate is pure
  // overhead.
  return sodium.crypto_secretbox_open_easy(bytes.subarray(n), bytes.subarray(0, n), key);
}
