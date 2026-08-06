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

describe('keystore', () => {
  beforeEach(() => store.clear());

  it('reports no seed on a fresh device', async () => {
    // A miss must read as "no identity", not as a thrown error that would
    // send a first-launch user to a crash screen instead of onboarding.
    expect(await loadSeed()).toBeNull();
  });

  it('round-trips a seed', async () => {
    const seed = new Uint8Array(32).fill(7);
    await storeSeed(seed);
    expect(Array.from((await loadSeed()) as Uint8Array)).toEqual(Array.from(seed));
  });

  it('forgets a seed on request', async () => {
    await storeSeed(new Uint8Array(32).fill(7));
    await clearSeed();
    expect(await loadSeed()).toBeNull();
  });

  it('writes under exactly one known key', async () => {
    await storeSeed(new Uint8Array(32).fill(7));
    expect([...store.keys()]).toEqual(['nearside.identity.seed']);
  });

  it('treats a stored seed as unconfirmed until it is marked', async () => {
    // The seed is written the moment it is generated, so "a seed exists"
    // cannot mean "the user copied the phrase" — that was the bug that let
    // backgrounding the app skip the confirmation screen.
    await storeSeed(new Uint8Array(32).fill(7));
    expect(await isSeedConfirmed()).toBe(false);
    await markSeedConfirmed();
    expect(await isSeedConfirmed()).toBe(true);
  });

  it('forgets the confirmation along with the seed', async () => {
    await storeSeed(new Uint8Array(32).fill(7));
    await markSeedConfirmed();
    await clearSeed();
    expect(await isSeedConfirmed()).toBe(false);
    expect([...store.keys()]).toEqual([]);
  });
});
