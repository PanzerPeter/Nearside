import { useEffect, useRef } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

// Throttle window for last_seen_at writes. 60s is frequent enough that
// "offline" friends still see a recent-looking timestamp, but coarse enough
// that a chatty tab isn't hammering the profiles row on every keystroke.
const WRITE_INTERVAL_MS = 60_000;

/**
 * Persists this device's presence as a `last_seen_at` timestamp on the
 * signed-in user's profile row, throttled to once per 60s.
 *
 * The local device clock is acceptable here, unlike anywhere else in this
 * codebase. `last_seen_at` is only ever formatted for display and never
 * compared against a server-stamped column, so clock skew costs nothing.
 * Receipts are watermarks compared against `messages.created_at` and must use
 * the server clock; see `src/lib/receipts.ts`.
 *
 * Writes fire on mount, on becoming visible, on `focus`, and on a 60s
 * interval. The interval alone is not enough: browsers clamp `setInterval` in
 * background tabs, so a tab hidden for a while does not tick on schedule. The
 * visibility and focus listeners cover the case that matters, someone coming
 * back to the app.
 */
export function useLastSeen(session: Session | null): void {
  const lastWriteAt = useRef(0);

  useEffect(() => {
    if (!session) return;
    const me = session.user.id;

    function write() {
      // A backgrounded tab isn't "seen" right now, no matter what the
      // interval or a stale focus event thinks — never write while hidden.
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastWriteAt.current < WRITE_INTERVAL_MS) return;
      lastWriteAt.current = now;

      supabase
        .from('profiles')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', me)
        .then(
          () => {},
          // The builder is a thenable, not a full Promise — a rejection
          // handler belongs here, not in a chained `.catch`. A missed write
          // just means a slightly stale "Last seen"; nothing to recover.
          () => {}
        );
    }

    write();

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') write();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', write);
    const interval = window.setInterval(write, WRITE_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', write);
      window.clearInterval(interval);
    };
  }, [session]);
}
