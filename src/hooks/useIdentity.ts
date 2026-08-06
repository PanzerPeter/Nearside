import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { generateMnemonic, seedFromMnemonic } from '../lib/crypto/mnemonic';
import { identityFromSeed, type Identity } from '../lib/crypto/keys';
import { clearSeed, loadSeed, storeSeed } from '../lib/keystore';

type Status = 'loading' | 'missing' | 'unconfirmed' | 'ready';

export function useIdentity(session: Session | null) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    if (!session) {
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
      setIdentity(await identityFromSeed(seed));
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

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

  /** The user typed the check words back. Nothing is written here: the seed is
   *  already stored, and this only releases the gate. */
  const confirmIdentity = useCallback(() => setStatus('ready'), []);

  const restoreIdentity = useCallback(async (phrase: string): Promise<void> => {
    const seed = await seedFromMnemonic(phrase);
    await storeSeed(seed);
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
