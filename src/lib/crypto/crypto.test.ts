import { describe, expect, it } from 'vitest';
import { generateMnemonic, isValidMnemonic, seedFromMnemonic } from './mnemonic';
import { identityFromSeed } from './keys';
import {
  openBytesFrom,
  openForSelf,
  openFrom,
  sealBytesFor,
  sealFor,
  sealForSelf,
  signBytes,
  signedPayload,
  verifyBytes,
} from './seal';
import { safetyNumber } from './safety';

const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('mnemonic', () => {
  it('generates twelve valid words', () => {
    const m = generateMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('rejects a phrase with a bad checksum', () => {
    expect(isValidMnemonic('legal winner thank year wave sausage worth useful legal winner thank thank')).toBe(false);
  });

  it('derives the same 32-byte seed every time', async () => {
    const a = await seedFromMnemonic(PHRASE);
    const b = await seedFromMnemonic(PHRASE);
    expect(a).toHaveLength(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  // A phrase is typed on a phone and pasted on a desktop, and a paste carries
  // whatever the source put around the words. bip39 splits on a single space
  // and nothing else, so every one of these reaches it as twelve words or as
  // an account the user cannot get back into.
  it('accepts a pasted phrase whatever whitespace came with it', () => {
    const wrapped = PHRASE.split(' ');
    expect(isValidMnemonic(`  ${PHRASE}  `)).toBe(true);
    expect(isValidMnemonic(PHRASE.replace(/ /g, '  '))).toBe(true);
    expect(isValidMnemonic(`${wrapped.slice(0, 6).join(' ')}\n${wrapped.slice(6).join(' ')}`)).toBe(true);
    expect(isValidMnemonic(PHRASE.replace(/ /g, '\t'))).toBe(true);
    // NBSP: what a browser or a PDF hands over instead of a space.
    expect(isValidMnemonic(PHRASE.replace(/ /g, '\u00A0'))).toBe(true);
  });

  it('accepts a phrase carrying invisible characters', () => {
    // Zero-width space, zero-width joiner, soft hyphen, BOM. Nothing renders,
    // so the user sees twelve correct words and is told they are wrong.
    expect(isValidMnemonic(`\uFEFF${PHRASE.replace(/ /g, '\u200B ')}`)).toBe(true);
    expect(isValidMnemonic(PHRASE.replace('winner', 'win\u00ADner'))).toBe(true);
  });

  it('still rejects a phrase whose words are wrong', () => {
    expect(isValidMnemonic('')).toBe(false);
    expect(isValidMnemonic(PHRASE.replace('yellow', 'yell'))).toBe(false);
    expect(isValidMnemonic(PHRASE.split(' ').slice(0, 11).join(' '))).toBe(false);
  });

  // The load-bearing one. Normalization may only rescue phrases that were
  // being rejected; it must not move the seed under an account that already
  // works, because that seed is the account and there is no reset path.
  it('does not change the seed of a phrase that was already valid', async () => {
    // Pinned to the value this phrase derived before normalization was
    // widened, not to a second call of the same function: a test that only
    // compares the code to itself would pass while every existing account's
    // keys moved underneath it.
    const hex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex(await seedFromMnemonic(PHRASE))).toBe(
      '878386efb78845b3355bd15ea4d39ef97d179cb712b77d5c12b6be415fffeffe'
    );
    expect(hex(await seedFromMnemonic(`  ${PHRASE}\n`))).toBe(hex(await seedFromMnemonic(PHRASE)));
  });
});

describe('identity', () => {
  it('derives three distinct keys from one seed', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    // Domain separation is the whole point: reusing one key as another is a
    // real cryptographic fault, and it would otherwise pass every other test.
    expect(Array.from(id.boxPrivate)).not.toEqual(Array.from(id.signPrivate));
    expect(Array.from(id.vaultKey)).not.toEqual(Array.from(id.boxPrivate));
    expect(id.boxPublic).toHaveLength(32);
    expect(id.signPublic).toHaveLength(32);
    expect(id.vaultKey).toHaveLength(32);
  });

  it('is reproducible from the phrase alone', async () => {
    const a = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const b = await identityFromSeed(await seedFromMnemonic(PHRASE));
    expect(Array.from(a.boxPublic)).toEqual(Array.from(b.boxPublic));
  });
});

describe('sealing to yourself', () => {
  it('round-trips', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const sealed = await sealForSelf(id.vaultKey, 'buy milk');
    expect(sealed.ciphertext).not.toContain('buy milk');
    expect(await openForSelf(id.vaultKey, sealed)).toBe('buy milk');
  });

  it('uses a fresh nonce every time', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const a = await sealForSelf(id.vaultKey, 'same text');
    const b = await sealForSelf(id.vaultKey, 'same text');
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses tampered ciphertext', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const sealed = await sealForSelf(id.vaultKey, 'buy milk');
    const bytes = atob(sealed.ciphertext).split('');
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 1);
    await expect(openForSelf(id.vaultKey, { ...sealed, ciphertext: btoa(bytes.join('')) }))
      .rejects.toThrow();
  });

  it('seals a long body without truncating it', async () => {
    // Every other fixture here is eight or nine characters, so a body silently
    // capped at a fixed length would pass the whole suite. That is not
    // hypothetical: it cost a live debugging session on Plan 2, where an
    // eight-byte plaintext in the database was indistinguishable from a
    // truncation bug until the caption turned out to be "Am Image".
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const long = 'a caption clearly longer than any test fixture, '.repeat(8);
    const sealed = await sealForSelf(id.vaultKey, long);
    expect(await openForSelf(id.vaultKey, sealed)).toBe(long);
    // secretbox adds a 16-byte tag and nothing else; a fixed-size ciphertext
    // means something upstream capped the plaintext.
    expect(atob(sealed.ciphertext).length).toBe(new TextEncoder().encode(long).length + 16);
  });

  it('round-trips a body that is not ASCII', async () => {
    // Byte length, not character count: the two differ for every accented
    // character the primary user types.
    const id = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const text = 'árvíztűrő tükörfúrógép 🔐';
    const sealed = await sealForSelf(id.vaultKey, text);
    expect(await openForSelf(id.vaultKey, sealed)).toBe(text);
    expect(atob(sealed.ciphertext).length).toBe(new TextEncoder().encode(text).length + 16);
  });
});

describe('sealing to a peer', () => {
  it('round-trips between two identities', async () => {
    const me = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const them = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const sealed = await sealFor(me.boxPrivate, them.boxPublic, 'hello');
    expect(await openFrom(them.boxPrivate, me.boxPublic, sealed)).toBe('hello');
  });

  it('refuses a third party', async () => {
    const me = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const them = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const other = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const sealed = await sealFor(me.boxPrivate, them.boxPublic, 'hello');
    await expect(openFrom(other.boxPrivate, me.boxPublic, sealed)).rejects.toThrow();
  });
});

describe('safety number', () => {
  it('is 12 groups of 5 digits', async () => {
    const a = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const b = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const n = await safetyNumber(a.boxPublic, b.boxPublic);
    expect(n.split(' ')).toHaveLength(12);
    expect(n.replace(/ /g, '')).toMatch(/^\d{60}$/);
  });

  it('does not depend on argument order', async () => {
    // Both people must read the same number off their screens, and neither
    // knows which of them "goes first".
    const a = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const b = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    expect(await safetyNumber(a.boxPublic, b.boxPublic)).toBe(await safetyNumber(b.boxPublic, a.boxPublic));
  });

  it('changes when a key changes', async () => {
    const a = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const b = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const c = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    expect(await safetyNumber(a.boxPublic, b.boxPublic)).not.toBe(await safetyNumber(a.boxPublic, c.boxPublic));
  });
});

describe('sealed bytes', () => {
  it('round-trips a raw key between two identities', async () => {
    // A room key is 32 random bytes, and it must survive the trip unchanged —
    // a text round-trip through base64 would be three chances to disagree.
    const me = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const them = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const key = new Uint8Array(32).map((_, i) => (i * 37) % 256);

    const sealed = await sealBytesFor(me.boxPrivate, them.boxPublic, key);
    const opened = await openBytesFrom(them.boxPrivate, me.boxPublic, sealed);
    expect(Array.from(opened)).toEqual(Array.from(key));
  });

  it('refuses a third party holding the ciphertext', async () => {
    const me = await identityFromSeed(await seedFromMnemonic(PHRASE));
    const them = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const other = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const sealed = await sealBytesFor(me.boxPrivate, them.boxPublic, new Uint8Array([1, 2, 3]));
    await expect(openBytesFrom(other.boxPrivate, me.boxPublic, sealed)).rejects.toThrow();
  });
});

describe('room message signatures', () => {
  it('verifies a signature from the right sender', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const payload = new Uint8Array([1, 2, 3]);
    const sig = await signBytes(id.signPrivate, payload);
    expect(await verifyBytes(id.signPublic, sig, payload)).toBe(true);
  });

  it('rejects a signature from a different member', async () => {
    // The attack this closes: every room member holds the room key, so any of
    // them could write a message claiming to be someone else.
    const alice = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const mallory = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const payload = new Uint8Array([1, 2, 3]);
    const sig = await signBytes(mallory.signPrivate, payload);
    expect(await verifyBytes(alice.signPublic, sig, payload)).toBe(false);
  });

  it('rejects a signature over different bytes', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const sig = await signBytes(id.signPrivate, new Uint8Array([1, 2, 3]));
    expect(await verifyBytes(id.signPublic, sig, new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('returns false rather than throwing on a malformed signature', async () => {
    const id = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    expect(await verifyBytes(id.signPublic, 'not base64 at all !!', new Uint8Array([1]))).toBe(
      false
    );
  });

  it('covers the nonce as well as the ciphertext', async () => {
    // Signing the ciphertext alone would leave the nonce swappable with the
    // signature still valid, which is a decryptable-to-garbage attack.
    const id = await identityFromSeed(await seedFromMnemonic(generateMnemonic()));
    const sealed = { ciphertext: 'AAAA', nonce: 'BBBB' };
    const sig = await signBytes(id.signPrivate, signedPayload(sealed));
    expect(await verifyBytes(id.signPublic, sig, signedPayload(sealed))).toBe(true);
    expect(
      await verifyBytes(id.signPublic, sig, signedPayload({ ciphertext: 'AAAA', nonce: 'CCCC' }))
    ).toBe(false);
  });
});
