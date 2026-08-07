import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
      return { value: true };
    },
    get: async ({ key }: { key: string }) => {
      if (!store.has(key)) throw new Error('not found');
      return { value: store.get(key) as string };
    },
    remove: async ({ key }: { key: string }) => {
      store.delete(key);
      return { value: true };
    },
  },
}));

import { clearSeed, isSeedConfirmed, loadSeed, markSeedConfirmed, storeSeed } from './keystore';

const ALICE = '29a4782b-b764-43a4-87e5-21a606b05ff3';
const BOB = '4c991d02-8ab2-4707-94d0-ba6484b71e13';

describe('keystore', () => {
  beforeEach(() => store.clear());

  it('reports no seed on a fresh device', async () => {
    // A miss must read as "no identity", not as a thrown error that would
    // send a first-launch user to a crash screen instead of onboarding.
    expect(await loadSeed(ALICE)).toBeNull();
  });

  it('round-trips a seed', async () => {
    const seed = new Uint8Array(32).fill(7);
    await storeSeed(ALICE, seed);
    expect(Array.from((await loadSeed(ALICE)) as Uint8Array)).toEqual(Array.from(seed));
  });

  it('forgets a seed on request', async () => {
    await storeSeed(ALICE, new Uint8Array(32).fill(7));
    await clearSeed(ALICE);
    expect(await loadSeed(ALICE)).toBeNull();
  });

  it('writes under exactly one known key', async () => {
    await storeSeed(ALICE, new Uint8Array(32).fill(7));
    expect([...store.keys()]).toEqual([`nearside.identity.seed.${ALICE}`]);
  });

  it('treats a stored seed as unconfirmed until it is marked', async () => {
    // The seed is written the moment it is generated, so "a seed exists"
    // cannot mean "the user copied the phrase" — that was the bug that let
    // backgrounding the app skip the confirmation screen.
    await storeSeed(ALICE, new Uint8Array(32).fill(7));
    expect(await isSeedConfirmed(ALICE)).toBe(false);
    await markSeedConfirmed(ALICE);
    expect(await isSeedConfirmed(ALICE)).toBe(true);
  });

  it('forgets the confirmation along with the seed', async () => {
    await storeSeed(ALICE, new Uint8Array(32).fill(7));
    await markSeedConfirmed(ALICE);
    await clearSeed(ALICE);
    expect(await isSeedConfirmed(ALICE)).toBe(false);
    expect([...store.keys()]).toEqual([]);
  });

  describe('two accounts on one device', () => {
    it('does not hand one account the seed of another', async () => {
      // The bug this replaces: a single device-wide slot meant the second
      // account to sign in inherited the first one's private key, published it
      // as its own, and could read everything sealed to the first.
      await storeSeed(ALICE, new Uint8Array(32).fill(7));
      expect(await loadSeed(BOB)).toBeNull();
    });

    it('does not let one account inherit another account’s confirmation', async () => {
      // Inheriting the flag is what skipped the phrase screen entirely for the
      // second account — it never saw the twelve words for its own key.
      await storeSeed(ALICE, new Uint8Array(32).fill(7));
      await markSeedConfirmed(ALICE);
      expect(await isSeedConfirmed(BOB)).toBe(false);
    });

    it('keeps both seeds when one account signs out', async () => {
      await storeSeed(ALICE, new Uint8Array(32).fill(7));
      await storeSeed(BOB, new Uint8Array(32).fill(9));
      await clearSeed(ALICE);
      expect(await loadSeed(ALICE)).toBeNull();
      expect(Array.from((await loadSeed(BOB)) as Uint8Array)).toEqual(
        Array.from(new Uint8Array(32).fill(9))
      );
    });

    it('holds each account’s seed separately', async () => {
      await storeSeed(ALICE, new Uint8Array(32).fill(7));
      await storeSeed(BOB, new Uint8Array(32).fill(9));
      expect(Array.from((await loadSeed(ALICE)) as Uint8Array)).toEqual(
        Array.from(new Uint8Array(32).fill(7))
      );
    });
  });

  describe('the unscoped seed left by builds before this fix', () => {
    it('is never adopted by an account', async () => {
      // It cannot be attributed: the device-wide slot was written by whichever
      // account onboarded first and then read by every account after it.
      // Guessing an owner is how the wrong account gets a private key.
      store.set('nearside.identity.seed', 'AAAA');
      store.set('nearside.identity.confirmed', 'true');
      expect(await loadSeed(ALICE)).toBeNull();
      expect(await isSeedConfirmed(ALICE)).toBe(false);
    });

    it('is purged from the device on the first scoped read', async () => {
      // Unowned private key material must not sit in the keystore forever.
      // The phrase is the user's copy; this device's copy has no owner.
      store.set('nearside.identity.seed', 'AAAA');
      store.set('nearside.identity.confirmed', 'true');
      await loadSeed(ALICE);
      expect(store.has('nearside.identity.seed')).toBe(false);
      expect(store.has('nearside.identity.confirmed')).toBe(false);
    });
  });
});
