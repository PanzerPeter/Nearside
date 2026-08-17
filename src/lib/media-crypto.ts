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
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const sealed = sodium.crypto_secretbox_easy(bytes, nonce, key);

  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  // application/octet-stream, always: a sealed JPEG announced as image/jpeg
  // tells anyone reading the bucket what it is.
  return { blob: new Blob([out], { type: 'application/octet-stream' }), key };
}

export async function openFile(bytes: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const n = sodium.crypto_secretbox_NONCEBYTES;
  return sodium.crypto_secretbox_open_easy(bytes.slice(n), bytes.slice(0, n), key);
}
