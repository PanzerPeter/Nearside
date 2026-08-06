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
}

const AUTO_DISMISS_MS = 5000;

interface ToastContextValue {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
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

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, kind, message }]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS)
    );
  }, []);

  const error = useCallback((message: string) => push('error', message), [push]);
  const success = useCallback((message: string) => push('success', message), [push]);

  const value = useMemo(
    () => ({ toasts, dismiss, error, success }),
    [toasts, dismiss, error, success]
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
  error: (message: string) => void;
  success: (message: string) => void;
} {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
