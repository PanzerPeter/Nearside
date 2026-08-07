import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { generateMnemonic, seedFromMnemonic } from '../lib/crypto/mnemonic';
import { identityFromSeed, type Identity } from '../lib/crypto/keys';
import { isSeedConfirmed, loadSeed, markSeedConfirmed, storeSeed } from '../lib/keystore';
import { setRecoveryConfirmed } from '../lib/notifications';

type Status = 'loading' | 'missing' | 'unconfirmed' | 'ready';

export function useIdentity(session: Session | null) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // The user id, not the session object: Capacitor hands out a fresh session
  // on every app resume, and re-running this effect for the same account
  // re-reads the seed and re-derives keys for nothing.
  //
  // It is also what the seed is filed under. Two accounts on one phone each get
  // their own key; neither can reach the other's.
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!userId) {
      setIdentity(null);
      setStatus('missing');
      return;
    }
    // Dropped before the load, not after it: the previous account's identity is
    // still in state at this point, and 'ready' is still the status. Leaving
    // either in place renders the app for the new account holding the old
    // account's key for as long as the read takes.
    setIdentity(null);
    setStatus('loading');

    let cancelled = false;
    void (async () => {
      const seed = await loadSeed(userId);
      if (cancelled) return;
      if (!seed) {
        setStatus('missing');
        return;
      }
      const derived = await identityFromSeed(seed);
      const confirmed = await isSeedConfirmed(userId);
      if (cancelled) return;
      setIdentity(derived);
      // A seed with no confirmation is a phrase the user was shown and never
      // copied. Reloading must put them back on that screen, not past it.
      setStatus(confirmed ? 'ready' : 'unconfirmed');
      // Reported to OneSignal every load, not only at the moment of
      // confirming: the In-App Message that chases an unconfirmed phrase
      // targets the absence of this tag, and a device that confirmed while
      // offline would otherwise be nagged forever.
      void setRecoveryConfirmed(confirmed);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /** Returns the phrase once, for the confirmation screen. It is deliberately
   *  not held anywhere else: the user's copy is the only copy.
   *
   *  The seed is persisted immediately — a phrase on screen that never reached
   *  disk is a key the user has written down and the device does not have —
   *  but status stops at 'unconfirmed' so the gate keeps the phrase visible
   *  until the human proves they copied it. */
  const createIdentity = useCallback(async (): Promise<string> => {
    if (!userId) throw new Error('no account to create an identity for');
    const mnemonic = generateMnemonic();
    const seed = await seedFromMnemonic(mnemonic);
    await storeSeed(userId, seed);
    void setRecoveryConfirmed(false);
    setIdentity(await identityFromSeed(seed));
    setStatus('unconfirmed');
    return mnemonic;
  }, [userId]);

  /** The user typed the check words back. The flag is persisted before the
   *  gate opens, so a resume — or a kill and relaunch — cannot land them back
   *  on a phrase screen for a key they have already copied, and cannot let
   *  someone past one they have not. */
  const confirmIdentity = useCallback(async (): Promise<void> => {
    if (!userId) return;
    await markSeedConfirmed(userId);
    void setRecoveryConfirmed(true);
    setStatus('ready');
  }, [userId]);

  const restoreIdentity = useCallback(
    async (phrase: string): Promise<void> => {
      if (!userId) throw new Error('no account to restore an identity for');
      const seed = await seedFromMnemonic(phrase);
      await storeSeed(userId, seed);
      // Restoring means the user is holding the phrase — there is nothing left
      // to prove, so this is confirmed on arrival.
      await markSeedConfirmed(userId);
      void setRecoveryConfirmed(true);
      setIdentity(await identityFromSeed(seed));
      setStatus('ready');
    },
    [userId]
  );

  return { identity, status, createIdentity, confirmIdentity, restoreIdentity };
}
