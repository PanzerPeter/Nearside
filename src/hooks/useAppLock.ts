import { useCallback, useEffect, useRef, useState } from 'react';
import { App } from '@capacitor/app';
import {
  backoffMs,
  clearFailures,
  clearLock,
  deriveVerifier,
  loadFailures,
  loadLock,
  matchesRecoveryPhrase,
  RELOCK_MS,
  remainingWaitMs,
  saveFailures,
  saveLock,
  verifyPassphrase,
  type LockFailures,
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
 * Wrong passphrases are counted in secure storage, not in memory, so killing
 * the app does not reset the backoff (`loadFailures`). The recovery phrase is
 * not throttled: twelve words with a checksum cannot be guessed, and it is the
 * owner's way out while the passphrase is waiting.
 */
export function useAppLock(userId: string | null): AppLock {
  const [state, setState] = useState<LockState>('loading');
  const [relock, setRelockState] = useState<RelockAfter>('1m');
  const [waitMs, setWaitMs] = useState(0);
  const failures = useRef<LockFailures>({ count: 0, at: 0 });
  const backgroundedAt = useRef<number | null>(null);

  /** Show whatever is left of the current backoff, and clear it when done. */
  const showWait = useCallback((ms: number) => {
    setWaitMs(ms);
    if (ms > 0) window.setTimeout(() => setWaitMs(0), ms);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setState('off');
      return;
    }
    setState('loading');
    void Promise.all([loadLock(userId), loadFailures(userId)]).then(([stored, missed]) => {
      if (cancelled) return;
      if (!stored) {
        setState('off');
        return;
      }
      failures.current = missed;
      showWait(remainingWaitMs(missed, Date.now()));
      setRelockState(stored.relock);
      // Locked on every cold start. A lock that only engages after the first
      // background is not a lock on a phone that was rebooted.
      setState('locked');
    });
    return () => {
      cancelled = true;
    };
  }, [userId, showWait]);

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

  /** A wrong passphrase: counted, written down before the wait is shown, so a
   *  kill during the wait cannot lose it. */
  const registerFailure = useCallback(async () => {
    if (!userId) return;
    const next = { count: failures.current.count + 1, at: Date.now() };
    failures.current = next;
    await saveFailures(userId, next).catch(() => {});
    showWait(backoffMs(next.count));
  }, [userId, showWait]);

  /** Back to a clean slate, in memory and on disk. */
  const resetFailures = useCallback(async () => {
    failures.current = { count: 0, at: 0 };
    setWaitMs(0);
    if (userId) await clearFailures(userId).catch(() => {});
  }, [userId]);

  const unlock = useCallback(
    async (passphrase: string) => {
      if (!userId) return false;
      if (remainingWaitMs(failures.current, Date.now()) > 0) return false;
      const stored = await loadLock(userId);
      if (!stored) {
        setState('off');
        return true;
      }
      const ok = await verifyPassphrase(passphrase, stored.verifier);
      if (!ok) {
        await registerFailure();
        return false;
      }
      await resetFailures();
      setState('unlocked');
      return true;
    },
    [userId, registerFailure, resetFailures]
  );

  const unlockWithRecoveryPhrase = useCallback(
    async (phrase: string) => {
      if (!userId) return false;
      // Not throttled and not counted: see the note on the hook.
      const ok = await matchesRecoveryPhrase(phrase, await loadSeed(userId));
      if (!ok) return false;
      await resetFailures();
      // The lock comes off rather than merely opening: the passphrase behind it
      // is the one the user has just told us they no longer have, and leaving
      // it in place would lock them out again at the next cold start.
      await clearLock(userId);
      setState('off');
      return true;
    },
    [userId, resetFailures]
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
    await resetFailures();
    setState('off');
  }, [userId, resetFailures]);

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
