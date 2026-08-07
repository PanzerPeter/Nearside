import sodium from 'libsodium-wrappers';

/** Both fields are base64. Stored as two columns, never concatenated — a
 *  nonce glued to a ciphertext is a parsing bug waiting for its first
 *  unusual length. */
export interface Sealed {
  ciphertext: string;
  nonce: string;
}

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

export async function sealForSelf(vaultKey: Uint8Array, plaintext: string): Promise<Sealed> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  return {
    ciphertext: b64(sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, vaultKey)),
    nonce: b64(nonce),
  };
}

export async function openForSelf(vaultKey: Uint8Array, sealed: Sealed): Promise<string> {
  await sodium.ready;
  return sodium.to_string(
    sodium.crypto_secretbox_open_easy(unb64(sealed.ciphertext), unb64(sealed.nonce), vaultKey)
  );
}

export async function sealFor(
  myPrivate: Uint8Array,
  theirPublic: Uint8Array,
  plaintext: string
): Promise<Sealed> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  return {
    ciphertext: b64(
      sodium.crypto_box_easy(sodium.from_string(plaintext), nonce, theirPublic, myPrivate)
    ),
    nonce: b64(nonce),
  };
}

export async function openFrom(
  myPrivate: Uint8Array,
  theirPublic: Uint8Array,
  sealed: Sealed
): Promise<string> {
  await sodium.ready;
  return sodium.to_string(
    sodium.crypto_box_open_easy(unb64(sealed.ciphertext), unb64(sealed.nonce), theirPublic, myPrivate)
  );
}

/**
 * Seal arbitrary bytes rather than a string.
 *
 * A room key is 32 random bytes, not text. Routing it through `sealFor` would
 * mean base64-encoding it, sealing the encoding, and decoding on the far side
 * — three chances for a padding variant to disagree with itself over something
 * that is already a byte array.
 */
export async function sealBytesFor(
  myPrivate: Uint8Array,
  theirPublic: Uint8Array,
  bytes: Uint8Array
): Promise<Sealed> {
  await sodium.ready;
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  return {
    ciphertext: b64(sodium.crypto_box_easy(bytes, nonce, theirPublic, myPrivate)),
    nonce: b64(nonce),
  };
}

export async function openBytesFrom(
  myPrivate: Uint8Array,
  theirPublic: Uint8Array,
  sealed: Sealed
): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_box_open_easy(
    unb64(sealed.ciphertext),
    unb64(sealed.nonce),
    theirPublic,
    myPrivate
  );
}

/**
 * Sign bytes with an Ed25519 key, detached.
 *
 * The attack this closes lives in rooms: every member holds the room key, so
 * `secretbox` proves only that *a* member wrote a message. Without a signature
 * any of them could compose a message, seal it under the shared key, and the
 * server's `sender_id` column would attest to whoever they claimed to be.
 */
export async function signBytes(signPrivate: Uint8Array, message: Uint8Array): Promise<string> {
  await sodium.ready;
  return b64(sodium.crypto_sign_detached(message, signPrivate));
}

/** False, never a throw. A bad signature is a routine event on a hostile
 *  network, and every call site has to handle it as data rather than as an
 *  exception it might forget to catch. */
export async function verifyBytes(
  signPublic: Uint8Array,
  signature: string,
  message: Uint8Array
): Promise<boolean> {
  await sodium.ready;
  try {
    return sodium.crypto_sign_verify_detached(unb64(signature), message, signPublic);
  } catch {
    return false;
  }
}

/** Sealed room content as one byte string, so a signature covers the nonce as
 *  well as the ciphertext. Signing the ciphertext alone would let anyone swap
 *  in a different nonce and leave the signature still valid. */
export function signedPayload(sealed: Sealed): Uint8Array {
  const parts = new TextEncoder().encode(`${sealed.nonce}.${sealed.ciphertext}`);
  return parts;
}
