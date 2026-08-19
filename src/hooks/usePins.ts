import { useEffect, useSyncExternalStore } from 'react';
import { loadPins, pinsSnapshot, subscribePins } from '../lib/pins';
import type { PinnedMedia } from '../lib/localdb';

/**
 * This account's pins, as a map the thread can consult while rendering.
 *
 * A store rather than component state because two different components move
 * it: the viewer pins and unpins, and the thread is what has to notice — they
 * are not in the same subtree, and the thread cannot go back to SQLite for
 * every bubble it draws.
 *
 * The load is fired here rather than at sign-in so the query happens when
 * something actually needs the answer, and it is idempotent: one row per
 * pinned attachment, read once per mount of whatever is showing a thread.
 */
export function usePins(): ReadonlyMap<string, PinnedMedia> {
  useEffect(() => {
    void loadPins().catch(() => {
      // Nothing to say. A store that will not answer costs the pinned-copy
      // fallback, and the ordinary media path still explains itself.
    });
  }, []);
  return useSyncExternalStore(subscribePins, pinsSnapshot, pinsSnapshot);
}
