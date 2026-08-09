import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import {
  backoffMs,
  clearLock,
  deriveVerifier,
  loadLock,
  matchesRecoveryPhrase,
  RELOCK_MS,
  saveLock,
  verifyPassphrase,
  type RelockAfter,
} from '../lib/app-lock';
import { loadSeed } from '../lib/keystore';

export type LockState = 'loading' | 'off' | 'locked' | 'unlocked';

export interface AppLock {
  state: LockState;
  relock: RelockAfter;
  waitMs: number;
  unlock(passphrase: string): Promise<boolean>;
  /** The forgotten-passphrase route: the twelve words open the app and take
   *  the lock off with them. */
  unlockWithRecoveryPhrase(phrase: string): Promise<boolean>;
  enable(passphrase: string, relock: RelockAfter): Promise<void>;
  disable(): Promise<void>;
  setRelock(relock: RelockAfter): Promise<void>;
  lockNow(): void;
}

/**
 * The lock's state machine.
 *
 * `state` starts at 'loading' and must gate rendering: a gate that assumes
 * 'off' while secure storage is still being read paints one frame of the
 * conversation list before the lock screen replaces it, which is the whole
 * thing the lock exists to prevent.
 *
 * Failure counts live in memory only. Persisting them would let a locked-out
 * owner sit out a five-minute backoff they cannot escape, and the way past a
 * forgotten passphrase — the recovery phrase — is throttled by the same
 * counter.
 */
export function useAppLock(userId: string | null): AppLock {
  const [state, setState] = useState<LockState>('loading');
  const [relock, setRelockState] = useState<RelockAfter>('1m');
  const [waitMs, setWaitMs] = useState(0);
  const failures = useRef(0);
  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setState('off');
      return;
    }
    setState('loading');
    void loadLock(userId).then((stored) => {
      if (cancelled) return;
      if (!stored) {
        setState('off');
        return;
      }
      setRelockState(stored.relock);
      // Locked on every cold start. A lock that only engages after the first
      // background is not a lock on a phone that was rebooted.
      setState('locked');
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Re-lock on return from the background, once the configured time has passed.
  // The clock is read on the way out and compared on the way back rather than
  // run as a timer: a timer in a suspended WebView does not fire.
  useEffect(() => {
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        backgroundedAt.current = Date.now();
        return;
      }
      const left = backgroundedAt.current;
      backgroundedAt.current = null;
      if (left === null) return;
      setState((current) => {
        if (current !== 'unlocked') return current;
        return Date.now() - left >= RELOCK_MS[relock] ? 'locked' : current;
      });
    });
    return () => {
      void handle.then((h) => h.remove());
    };
  }, [relock]);

  /** One counter for both routes in, so the phrase field is not a way around
   *  the throttle on the passphrase field. */
  const registerFailure = useCallback(() => {
    failures.current += 1;
    const wait = backoffMs(failures.current);
    setWaitMs(wait);
    if (wait > 0) window.setTimeout(() => setWaitMs(0), wait);
  }, []);

  const unlock = useCallback(
    async (passphrase: string) => {
      if (!userId) return false;
      if (backoffMs(failures.current) > 0) return false;
      const stored = await loadLock(userId);
      if (!stored) {
        setState('off');
        return true;
      }
      const ok = await verifyPassphrase(passphrase, stored.verifier);
      if (!ok) {
        registerFailure();
        return false;
      }
      failures.current = 0;
      setWaitMs(0);
      setState('unlocked');
      return true;
    },
    [userId, registerFailure]
  );

  const unlockWithRecoveryPhrase = useCallback(
    async (phrase: string) => {
      if (!userId) return false;
      if (backoffMs(failures.current) > 0) return false;
      const ok = await matchesRecoveryPhrase(phrase, await loadSeed(userId));
      if (!ok) {
        registerFailure();
        return false;
      }
      failures.current = 0;
      setWaitMs(0);
      // The lock comes off rather than merely opening: the passphrase behind it
      // is the one the user has just told us they no longer have, and leaving
      // it in place would lock them out again at the next cold start.
      await clearLock(userId);
      setState('off');
      return true;
    },
    [userId, registerFailure]
  );

  const enable = useCallback(
    async (passphrase: string, next: RelockAfter) => {
      if (!userId) return;
      await saveLock(userId, await deriveVerifier(passphrase), next);
      setRelockState(next);
      // Unlocked, not locked: the user has this second proved they know it.
      setState('unlocked');
    },
    [userId]
  );

  const disable = useCallback(async () => {
    if (!userId) return;
    await clearLock(userId);
    failures.current = 0;
    setWaitMs(0);
    setState('off');
  }, [userId]);

  const setRelock = useCallback(
    async (next: RelockAfter) => {
      if (!userId) return;
      const stored = await loadLock(userId);
      if (!stored) return;
      await saveLock(userId, stored.verifier, next);
      setRelockState(next);
    },
    [userId]
  );

  const lockNow = useCallback(() => {
    setState((current) => (current === 'unlocked' ? 'locked' : current));
  }, []);

  return {
    state,
    relock,
    waitMs,
    unlock,
    unlockWithRecoveryPhrase,
    enable,
    disable,
    setRelock,
    lockNow,
  };
}
