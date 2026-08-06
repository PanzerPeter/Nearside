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
