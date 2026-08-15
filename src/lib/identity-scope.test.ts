import { describe, expect, it } from 'vitest';
import { scopedIdentity, scopedStatus, type ScopedIdentity } from './identity-scope';
import type { Identity } from './crypto/keys';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

/** Only its identity matters here, not its contents. */
const key = (tag: number): Identity =>
  ({
    boxPublic: new Uint8Array([tag]),
    boxPrivate: new Uint8Array([tag]),
    signPublic: new Uint8Array([tag]),
    signPrivate: new Uint8Array([tag]),
    vaultKey: new Uint8Array([tag]),
  }) as unknown as Identity;

const held = (userId: string, tag: number): ScopedIdentity => ({
  userId,
  identity: key(tag),
  status: 'ready',
});

describe('scopedIdentity', () => {
  it('hands back the identity derived for this account', () => {
    expect(scopedIdentity(held(A, 1), A)).toEqual(key(1));
  });

  it('withholds an identity derived for a different account', () => {
    // The switch case: the session is already B while the derivation still
    // belongs to A. Handing A's key over here is what published A's public key
    // into B's profile row.
    expect(scopedIdentity(held(A, 1), B)).toBeNull();
  });

  it('has no identity for nobody signed in', () => {
    expect(scopedIdentity(held(A, 1), null)).toBeNull();
  });

  it('has no identity before the first derivation lands', () => {
    expect(scopedIdentity(null, A)).toBeNull();
  });

  it('passes through an account whose seed is absent', () => {
    expect(scopedIdentity({ userId: A, identity: null, status: 'missing' }, A)).toBeNull();
  });
});

describe('scopedStatus', () => {
  it('reports the held status for its own account', () => {
    expect(scopedStatus({ userId: A, identity: null, status: 'missing' }, A)).toBe('missing');
    expect(scopedStatus(held(A, 1), A)).toBe('ready');
  });

  it('reports loading, not ready, while the held derivation is another account\'s', () => {
    // 'ready' here would render the app for B against A's key; 'missing' would
    // offer B a new recovery phrase over a seed it already has.
    expect(scopedStatus(held(A, 1), B)).toBe('loading');
  });

  it("reports loading, not missing, for an account not yet read", () => {
    expect(scopedStatus(null, A)).toBe('loading');
  });

  it('reports missing when nobody is signed in', () => {
    expect(scopedStatus(held(A, 1), null)).toBe('missing');
    expect(scopedStatus(null, null)).toBe('missing');
  });
});
