// Which account a derived identity belongs to, and what to do when that is not
// the account currently signed in.
//
// `useIdentity` holds a derived keypair in state and re-derives it when the
// signed-in user changes. Those are two separate pieces of state — the session
// and the derivation — and React updates them in that order: the render in
// which `session` has become account B still holds account A's identity,
// because the effect that clears it has not run yet.
//
// Anything reading both in that render sees a matched pair that is not one. The
// failure it caused was not cosmetic: `syncPublicKeys` ran with session B and
// identity A and wrote **A's public key into B's profile row**, so the peer
// sealed to a key B does not hold and the two devices computed safety numbers
// over different key material. The connect QR is built from the same identity
// and would have advertised the same wrong key.
//
// So the identity is filed under the account it was derived for, and read back
// only for that account. Held together in one object rather than checked by the
// caller, because a rule every caller has to remember is one some caller will
// not.

import type { Identity } from './crypto/keys';

export type IdentityStatus = 'loading' | 'missing' | 'unconfirmed' | 'ready';

/** A derivation, and whose it is. */
export interface ScopedIdentity {
  userId: string;
  identity: Identity | null;
  status: IdentityStatus;
}

/**
 * The identity to hand out for `userId`, or null when what is held belongs to
 * somebody else.
 *
 * Nobody signed in has no identity, which is a different thing from an account
 * whose seed has not been read yet — hence null rather than a status.
 */
export function scopedIdentity(
  held: ScopedIdentity | null,
  userId: string | null
): Identity | null {
  if (!userId || !held || held.userId !== userId) return null;
  return held.identity;
}

/**
 * The status to report for `userId`.
 *
 * A derivation for another account reads as 'loading', never as its own status:
 * reporting the previous account's 'ready' is what let the app render a
 * conversation for the new account against the old account's key, and reporting
 * 'missing' would send somebody with a perfectly good seed to the screen that
 * offers to make them a new one.
 */
export function scopedStatus(
  held: ScopedIdentity | null,
  userId: string | null
): IdentityStatus {
  if (!userId) return 'missing';
  if (!held || held.userId !== userId) return 'loading';
  return held.status;
}
