import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    get: ({ key }: { key: string }) => {
      const value = store.get(key);
      // The plugin throws rather than returning null for an absent key; the
      // real one does this too, and code under test depends on it.
      if (value === undefined) return Promise.reject(new Error('not found'));
      return Promise.resolve({ value });
    },
    set: ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
      return Promise.resolve({ value: true });
    },
    remove: ({ key }: { key: string }) => {
      store.delete(key);
      return Promise.resolve({ value: true });
    },
  },
}));

import { backoffMs, deriveVerifier, MIN_PASSPHRASE_LENGTH, verifyPassphrase } from './app-lock';

describe('deriveVerifier', () => {
  it('produces a different salt every time', async () => {
    const a = await deriveVerifier('correct horse');
    const b = await deriveVerifier('correct horse');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('is reproducible when the salt is reused', async () => {
    const first = await deriveVerifier('correct horse');
    const salt = Uint8Array.from(atob(first.salt), (c) => c.charCodeAt(0));
    const again = await deriveVerifier('correct horse', salt);
    expect(again.hash).toBe(first.hash);
  });

  it('rejects a passphrase shorter than the minimum', async () => {
    await expect(deriveVerifier('a'.repeat(MIN_PASSPHRASE_LENGTH - 1))).rejects.toThrow(/at least/);
  });
});

describe('verifyPassphrase', () => {
  it('accepts the passphrase it was derived from', async () => {
    const verifier = await deriveVerifier('correct horse');
    expect(await verifyPassphrase('correct horse', verifier)).toBe(true);
  });

  it('rejects anything else', async () => {
    const verifier = await deriveVerifier('correct horse');
    expect(await verifyPassphrase('correct horsé', verifier)).toBe(false);
    expect(await verifyPassphrase('', verifier)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('lets the first four attempts through unpenalised', () => {
    for (let n = 0; n < 4; n++) expect(backoffMs(n)).toBe(0);
  });

  it('doubles from five seconds and stops at five minutes', () => {
    expect(backoffMs(4)).toBe(5_000);
    expect(backoffMs(5)).toBe(10_000);
    expect(backoffMs(6)).toBe(20_000);
    expect(backoffMs(40)).toBe(300_000);
  });
});

describe('lock storage', () => {
  beforeEach(() => store.clear());

  it('returns null when no lock is set for this account', async () => {
    const { loadLock } = await import('./app-lock');
    expect(await loadLock('user-a')).toBeNull();
  });

  it('round-trips a verifier and a relock setting', async () => {
    const { deriveVerifier, loadLock, saveLock } = await import('./app-lock');
    const verifier = await deriveVerifier('correct horse');
    await saveLock('user-a', verifier, '5m');
    expect(await loadLock('user-a')).toEqual({ verifier, relock: '5m' });
  });

  it('scopes the lock to one account', async () => {
    const { deriveVerifier, loadLock, saveLock } = await import('./app-lock');
    await saveLock('user-a', await deriveVerifier('correct horse'), '1m');
    expect(await loadLock('user-b')).toBeNull();
  });

  it('clears only the account it was asked to clear', async () => {
    const { clearLock, deriveVerifier, loadLock, saveLock } = await import('./app-lock');
    const verifier = await deriveVerifier('correct horse');
    await saveLock('user-a', verifier, '1m');
    await saveLock('user-b', verifier, '1m');
    await clearLock('user-a');
    expect(await loadLock('user-a')).toBeNull();
    expect(await loadLock('user-b')).not.toBeNull();
  });

  it('treats a corrupt entry as no lock rather than as a locked-out account', async () => {
    const { loadLock } = await import('./app-lock');
    store.set('nearside.lock.user-a', 'not json');
    expect(await loadLock('user-a')).toBeNull();
  });
});
