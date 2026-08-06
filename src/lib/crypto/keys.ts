import sodium from 'libsodium-wrappers';

export interface Identity {
  boxPublic: Uint8Array;
  boxPrivate: Uint8Array;
  signPublic: Uint8Array;
  signPrivate: Uint8Array;
  vaultKey: Uint8Array;
}

/** Distinct labels so three independent keys come out of one seed. Changing
 *  any of these strings invalidates every existing user's keys. */
const BOX_CONTEXT = 'nearside-box-v1';
const SIGN_CONTEXT = 'nearside-sign-v1';
const VAULT_CONTEXT = 'nearside-vault-v1';

const KEY_BYTES = 32;

async function derive(seed: Uint8Array, context: string): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.crypto_generichash(KEY_BYTES, sodium.from_string(context), seed);
}

export async function identityFromSeed(seed: Uint8Array): Promise<Identity> {
  await sodium.ready;
  const box = sodium.crypto_box_seed_keypair(await derive(seed, BOX_CONTEXT));
  const sign = sodium.crypto_sign_seed_keypair(await derive(seed, SIGN_CONTEXT));
  return {
    boxPublic: box.publicKey,
    boxPrivate: box.privateKey,
    signPublic: sign.publicKey,
    signPrivate: sign.privateKey,
    vaultKey: await derive(seed, VAULT_CONTEXT),
  };
}

export async function toBase64(bytes: Uint8Array): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export async function fromBase64(text: string): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
}
