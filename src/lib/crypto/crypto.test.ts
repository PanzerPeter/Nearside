import { describe, expect, it } from 'vitest';
import { generateMnemonic, isValidMnemonic, seedFromMnemonic } from './mnemonic';
import { identityFromSeed } from './keys';
import { openForSelf, openFrom, sealFor, sealForSelf } from './seal';
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
