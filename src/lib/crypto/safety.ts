import sodium from 'libsodium-wrappers';

const DIGITS = 60;
const GROUP = 5;
const HASH_BYTES = 32;

/**
 * A number both people can read aloud and compare. Keys are sorted before
 * hashing so the two devices agree without either being "first", and the
 * digest is rendered as digits rather than hex because digits survive being
 * read over a table.
 */
export async function safetyNumber(a: Uint8Array, b: Uint8Array): Promise<string> {
  await sodium.ready;
  const [first, second] = [a, b].sort((x, y) => sodium.compare(x, y));
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  // Unkeyed: an explicit null key, because the typings do not treat it as
  // optional and a safety number has no secret to hash under.
  const digest = sodium.crypto_generichash(HASH_BYTES, combined, null);
  let out = '';
  for (let i = 0; out.length < DIGITS; i++) {
    out += (digest[i % digest.length] * 256 + digest[(i + 1) % digest.length])
      .toString()
      .padStart(GROUP, '0');
  }
  return (out.slice(0, DIGITS).match(/.{5}/g) as string[]).join(' ');
}
