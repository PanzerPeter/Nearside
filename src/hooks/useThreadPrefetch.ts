// Warm the newest page of the conversations most likely to be opened next.
//
// The choosing is `lib/prefetch.ts`, which is pure and tested; everything here
// is the fetching and the restraint around it. Three gates, and all three are
// about not spending somebody's data on a guess:
//
//   - Only while realtime reports healthy. A degraded connection is already
//     polling every six seconds to keep messages moving, and a prefetch queued
//     behind that is competing with the thing the user is waiting for.
//   - Only while the app is in front. A backgrounded phone is about to have its
//     WebView frozen, and waking the radio for a chat nobody is looking at is
//     the exact cost this feature is supposed to be reducing elsewhere.
//   - One conversation at a time, with a gap between them. Five pages issued at
//     once is the wake-up stampede in miniature, and on a weak link they would
//     all time out together.
//
// Pages are opened as well as cached, which is what makes this worth more than
// a faster first paint: `openRows` mirrors the plaintext, so the conversations
// warmed here also become searchable and get their sidebar preview for free —
// work `useConversationPreviews` would otherwise do one row at a time.

import { useEffect, useRef } from 'react';
import { fetchLatestPage } from '../lib/message-queries';
import { putSealedRows, sealedNewestByPeer } from '../lib/localdb';
import { openRows } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import { conversationsToPrefetch, type PrefetchCandidate } from '../lib/prefetch';
import { useConnection } from '../lib/connection';
import type { Identity } from '../lib/crypto/keys';

/** Wait between two prefetched conversations. Long enough that a page in
 *  flight for something the user actually did — sending, opening a chat — is
 *  never queued behind a burst of speculative ones. */
const BETWEEN_MS = 1_200;

/** How long after the list settles before any of this starts. The first
 *  seconds after a cold start already carry the profile, the list, the receipts
 *  and whatever conversation the user is opening; this waits for that to be
 *  over rather than joining it. */
const SETTLE_MS = 2_500;

export function useThreadPrefetch(
  me: string,
  identity: Identity | null,
  rows: readonly PrefetchCandidate[]
): void {
  const { live } = useConnection();
  /** Peers tried this run, whatever the outcome — see `conversationsToPrefetch`. */
  const attempted = useRef<Set<string>>(new Set());

  // Keyed on the peers and their newest timestamps rather than the array, which
  // gets a fresh identity on every list refetch — including the refetches this
  // hook's own writes provoke.
  const signature = rows.map((r) => `${r.peer_id}@${r.last_at ?? ''}`).join(',');

  useEffect(() => {
    if (!identity || !live || rows.length === 0) return;
    let alive = true;

    const timer = setTimeout(() => {
      void (async () => {
        const newestCached = await sealedNewestByPeer();
        if (!alive) return;
        const targets = conversationsToPrefetch(rows, newestCached, attempted.current);

        for (const peerId of targets) {
          if (!alive) return;
          // Re-checked per conversation rather than once at the top: this loop
          // spans several seconds, and the app being put away or the socket
          // dropping mid-pass should stop it where it is.
          if (document.visibilityState !== 'visible') return;
          attempted.current.add(peerId);
          try {
            const page = await fetchLatestPage(me, peerId);
            if (!alive) return;
            if (page.length > 0) {
              await putSealedRows(peerId, page);
              // Opened for the mirror, not for the screen: nothing is rendering
              // this conversation, and the plaintext it writes is what makes it
              // searchable and gives the sidebar its preview line.
              await openRows(identity, await peerPublicKey(peerId), peerId, page);
            }
          } catch {
            // Left in `attempted`, so the failure is not retried this run. The
            // conversation loads the ordinary way when somebody opens it.
          }
          await new Promise((resolve) => setTimeout(resolve, BETWEEN_MS));
        }
      })();
    }, SETTLE_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `rows` is covered by `signature`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, me, identity, live]);
}
