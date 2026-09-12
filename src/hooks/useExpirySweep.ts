import { useEffect } from 'react';
import { dropExpired } from '../lib/disappearing';
import { purgeExpired } from '../lib/localdb';
import { unpinMedia } from '../lib/pins';

/** How often the open thread checks. Short enough that an expiry is not
 *  visibly overdue, and cheap: two indexed deletes and a filter that returns
 *  its own input when nothing expired. */
const SWEEP_MS = 15_000;

/**
 * Take expired messages off the screen while the conversation is open.
 *
 * The server stamps `expires_at` and pg_cron deletes the row, but neither
 * touches a thread somebody is looking at: without this the message sits there
 * until the view is closed and reopened, which is a timer nobody believes.
 *
 * Shared by the 1:1 thread and the group view because both hold their own list
 * of rows — a sweep in one of them leaves the other showing messages the server
 * has already deleted.
 *
 * Deliberately independent of every network read. The sweep only needs a
 * timestamp the row already carries, so a failed fetch beside it must not be
 * able to skip it.
 */
export function useExpirySweep<T extends { id: string; expires_at?: string | null }>(
  setMessages: (update: (current: T[]) => T[]) => void,
  /** Bumped on wake, so a phone that slept through an expiry sweeps on return
   *  rather than waiting out the rest of the interval. */
  generation: number
) {
  useEffect(() => {
    let cancelled = false;

    async function sweep() {
      const removed = await purgeExpired(Date.now());
      if (cancelled) return;
      // A pin keeps a picture past the server's pruning, not past a timer both
      // people agreed to. Left behind, the decrypted bytes would outlive the
      // message in app-private storage with nothing left pointing at them.
      for (const id of removed) await unpinMedia(id).catch(() => {});
      if (cancelled) return;
      const gone = new Set(removed);
      const now = Date.now();
      setMessages((current) => dropExpired(current, now, gone) as T[]);
    }

    void sweep();
    const tick = window.setInterval(() => void sweep(), SWEEP_MS);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [setMessages, generation]);
}
