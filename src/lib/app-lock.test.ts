import { describe, expect, it } from 'vitest';
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
