import sodium from 'libsodium-wrappers';

/** One side of a conversation, as the safety number sees it. */
export interface SafetyParty {
  id: string;
  box: Uint8Array;
  /** Null for an account that never published one. Encoded as empty, which no
   *  real key is, so it cannot collide with one. */
  sign: Uint8Array | null;
}

/** Bumped with any change to what goes into a half, so a QR from a different
 *  version reads as "update the app", never as an interception. */
export const SAFETY_VERSION = 2;

const LABEL = 'nearside-safety-v2';
const GROUPS_PER_HALF = 6;
const GROUP_BYTES = 5;

/**
 * Thirty digits that belong to one person and nobody else.
 *
 * Covers the signing key as well as the box key. Version 1 hashed the box keys
 * alone, so verifying a contact said nothing about the signing key their group
 * messages are checked against: a server that served the right box key and its
 * own signing key the first time a group was opened got that key pinned under a
 * contact marked verified. The account id is in too, so the digits name an
 * account and not merely a key.
 *
 * Every field is length-prefixed, so no two different inputs encode alike.
 * Each five-digit group reads its own five bytes (a 40-bit value mod 100000,
 * bias under one in ten million); version 1 read two bytes per group with each
 * byte shared by its neighbour, which left sixty digits carrying 104 bits.
 */
function half(p: SafetyParty): string {
  const fields = [sodium.from_string(LABEL), sodium.from_string(p.id), p.box, p.sign ?? new Uint8Array()];
  const input = new Uint8Array(fields.reduce((n, f) => n + 1 + f.length, 0));
  let at = 0;
  for (const f of fields) {
    input[at++] = f.length;
    input.set(f, at);
    at += f.length;
  }
  // Unkeyed: an explicit null key, because the typings do not treat it as
  // optional and a safety number has no secret to hash under.
  const d = sodium.crypto_generichash(32, input, null);
  let out = '';
  for (let g = 0; g < GROUPS_PER_HALF; g++) {
    let v = 0;
    for (let i = 0; i < GROUP_BYTES; i++) v = v * 256 + d[g * GROUP_BYTES + i];
    out += String(v % 100000).padStart(5, '0');
  }
  return out;
}

/**
 * A number both people can read aloud and compare: each person's thirty
 * digits, ordered by account id so the two devices agree without either being
 * "first". Your own half is the same in every conversation you have. Rendered
 * as digits rather than hex because digits survive being read over a table.
 */
export async function safetyNumber(a: SafetyParty, b: SafetyParty): Promise<string> {
  await sodium.ready;
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const digits = half(first) + half(second);
  return (digits.match(/.{5}/g) as string[]).join(' ');
}
