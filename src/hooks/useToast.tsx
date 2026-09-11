// Transient toast surface, replacing the static, never-clearing error bars
// that used to live in per-component `error`/`notice` state.
//
// Each toast auto-dismisses after 5s. `error`/`success` are exposed as
// `useCallback`s with an empty dep list so consumers can put them in effect
// dep arrays without re-running on every render — they close over `setToasts`
// (a stable setter) and a ref-based id counter rather than any render-scoped
// state, so there is nothing for them to grow stale against.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';

export type ToastKind = 'error' | 'success';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** One button inside the toast, for an action that is only offered while the
   *  toast is up — undoing a delete is the case this exists for. Taking the
   *  action dismisses the toast. */
  action?: { label: string; onAct: () => void };
  /** Run if the toast goes away without the action being taken — by the timer
   *  or by the close button. Where the deferred work actually happens: the
   *  toast's own lifetime *is* the window to change your mind. */
  onExpire?: () => void;
}

const AUTO_DISMISS_MS = 5000;

interface ToastContextValue {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
  /** Take a toast's offered action, which cancels its `onExpire`. */
  act: (id: number) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  /** A toast that offers a way out, and does something when nobody takes it.
   *  Returns nothing: the caller's `onExpire` is the continuation. */
  offer: (message: string, action: ToastItem['action'], onExpire: () => void) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Read by `act`, which must not be rebuilt when the list changes — every
  // consumer puts these callbacks in dependency arrays.
  const toastsRef = useRef<ToastItem[]>([]);
  toastsRef.current = toasts;
  // A ref, not state, so `push` below can stay referentially stable — reading
  // it doesn't need a re-render, only the next call needs the updated value.
  const nextId = useRef(0);
  // One timer per live toast, keyed by id, so a toast dismissed early (via the
  // button) can have its pending auto-dismiss cancelled instead of firing a
  // second, harmless-but-wasted `setToasts` after the id is already gone.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const liveTimers = timers.current;
    return () => {
      for (const timer of liveTimers.values()) clearTimeout(timer);
      liveTimers.clear();
    };
  }, []);

  // What to run when a toast goes without its action being taken. Kept beside
  // the toast list rather than inside it so `dismiss` can claim an entry and be
  // certain it runs exactly once — the auto-dismiss timer and the close button
  // both arrive here, and a deferred delete that ran twice would be a second
  // write against a row that is already a tombstone.
  const expiries = useRef(new Map<number, () => void>());

  const forget = useCallback((id: number, run: boolean) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    const onExpire = expiries.current.get(id);
    expiries.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (run) onExpire?.();
  }, []);

  /** Close a toast the way the close button does: the offer was not taken, so
   *  whatever was waiting on it goes ahead. */
  const dismiss = useCallback((id: number) => forget(id, true), [forget]);

  /** The action was taken, so the deferred work is abandoned. */
  const act = useCallback(
    (id: number) => {
      const toast = toastsRef.current.find((t) => t.id === id);
      forget(id, false);
      toast?.action?.onAct();
    },
    [forget]
  );

  const push = useCallback(
    (kind: ToastKind, message: string, extra?: Partial<ToastItem>) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, kind, message, ...extra }]);
      if (extra?.onExpire) expiries.current.set(id, extra.onExpire);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          const onExpire = expiries.current.get(id);
          expiries.current.delete(id);
          setToasts((prev) => prev.filter((t) => t.id !== id));
          onExpire?.();
        }, AUTO_DISMISS_MS)
      );
    },
    []
  );

  const error = useCallback((message: string) => push('error', message), [push]);
  const success = useCallback((message: string) => push('success', message), [push]);
  const offer = useCallback(
    (message: string, action: ToastItem['action'], onExpire: () => void) =>
      push('success', message, { action, onExpire }),
    [push]
  );

  // A toast still waiting on its expiry when the app tears down has to run it:
  // the delete was confirmed and only the grace period is being cut short.
  useEffect(() => {
    const pending = expiries.current;
    return () => {
      for (const onExpire of pending.values()) onExpire();
      pending.clear();
    };
  }, []);

  const value = useMemo(
    () => ({ toasts, dismiss, act, error, success, offer }),
    [toasts, dismiss, act, error, success, offer]
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

// Also carries `toasts`/`dismiss` beyond the documented `{ error, success }`
// shape so `Toast.tsx` can render the stack via this same hook rather than
// reaching into the context directly — callers that only destructure
// `error`/`success` are unaffected.
//
// react-refresh/only-export-components fires because this file exports a
// component (ToastProvider) alongside a hook, same as the pre-existing
// pattern in usePresence.tsx. That pairing is required by this hook's own
// contract (provider + consumer colocated), so it's suppressed rather than
// split across files.
// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
  /** Take a toast's offered action, which cancels its `onExpire`. */
  act: (id: number) => void;
  error: (message: string) => void;
  success: (message: string) => void;
  /** A toast that offers a way out, and does something when nobody takes it.
   *  Returns nothing: the caller's `onExpire` is the continuation. */
  offer: (message: string, action: ToastItem['action'], onExpire: () => void) => void;
} {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
