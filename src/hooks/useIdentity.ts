import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { generateMnemonic, seedFromMnemonic } from '../lib/crypto/mnemonic';
import { identityFromSeed, type Identity } from '../lib/crypto/keys';
import { clearSeed, isSeedConfirmed, loadSeed, markSeedConfirmed, storeSeed } from '../lib/keystore';

type Status = 'loading' | 'missing' | 'unconfirmed' | 'ready';

export function useIdentity(session: Session | null) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // The user id, not the session object: Capacitor hands out a fresh session
  // on every app resume, and re-running this effect for the same account
  // re-reads the seed and re-derives keys for nothing.
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!userId) {
      setIdentity(null);
      setStatus('missing');
      return;
    }
    let cancelled = false;
    void (async () => {
      const seed = await loadSeed();
      if (cancelled) return;
      if (!seed) {
        setStatus('missing');
        return;
      }
      const derived = await identityFromSeed(seed);
      const confirmed = await isSeedConfirmed();
      if (cancelled) return;
      setIdentity(derived);
      // A seed with no confirmation is a phrase the user was shown and never
      // copied. Reloading must put them back on that screen, not past it.
      setStatus(confirmed ? 'ready' : 'unconfirmed');
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
    const mnemonic = generateMnemonic();
    const seed = await seedFromMnemonic(mnemonic);
    await storeSeed(seed);
    setIdentity(await identityFromSeed(seed));
    setStatus('unconfirmed');
    return mnemonic;
  }, []);

  /** The user typed the check words back. The flag is persisted before the
   *  gate opens, so a resume — or a kill and relaunch — cannot land them back
   *  on a phrase screen for a key they have already copied, and cannot let
   *  someone past one they have not. */
  const confirmIdentity = useCallback(async (): Promise<void> => {
    await markSeedConfirmed();
    setStatus('ready');
  }, []);

  const restoreIdentity = useCallback(async (phrase: string): Promise<void> => {
    const seed = await seedFromMnemonic(phrase);
    await storeSeed(seed);
    // Restoring means the user is holding the phrase — there is nothing left
    // to prove, so this is confirmed on arrival.
    await markSeedConfirmed();
    setIdentity(await identityFromSeed(seed));
    setStatus('ready');
  }, []);

  const forgetIdentity = useCallback(async (): Promise<void> => {
    await clearSeed();
    setIdentity(null);
    setStatus('missing');
  }, []);

  return { identity, status, createIdentity, confirmIdentity, restoreIdentity, forgetIdentity };
}
