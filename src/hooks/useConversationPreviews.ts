import { useEffect, useRef, useState } from 'react';
import type { Identity } from '../lib/crypto/keys';
import { cachedPreview } from '../lib/localdb';
import { fetchNewestMessage } from '../lib/message-queries';
import { peerPublicKey } from '../lib/peer-keys';
import { openRows } from '../lib/sealed-body';
import { previewProbeKey, stalePreviews } from '../lib/previews';

interface PreviewRow {
  peer_id: string;
  last_at: string | null;
}

/**
 * The last line of each conversation in the sidebar, opened if it has to be.
 *
 * The mirror is the only copy of the plaintext, and it is written by `openRows`
 * — which runs for a thread somebody has on screen. Everything that arrives
 * while the list is in front, or while another chat is open, or while the app
 * is closed, therefore reaches the list sealed, and the row says "Encrypted
 * message" about a message this device holds the key to.
 *
 * So a row the mirror cannot answer for is fetched and opened here, one row per
 * conversation rather than a page, capped per pass. `openRows` mirrors what it
 * opens on the way through, so the second pass over the same conversation costs
 * nothing and the thread finds the body already cached.
 *
 * A probe that comes back with no body — an uncaptioned photo, or a peer whose
 * key this device genuinely cannot resolve — is remembered so it is not retried
 * on every refresh. Those rows keep their honest "Encrypted message".
 */
export function useConversationPreviews(
  me: string,
  identity: Identity | null,
  rows: readonly PreviewRow[]
): Map<string, string | null> {
  const [previews, setPreviews] = useState<Map<string, string | null>>(new Map());
  /** Probe keys already tried this session; see `previewProbeKey`. */
  const attempted = useRef<Set<string>>(new Set());

  // Keyed on the peers and their newest timestamps rather than the array, which
  // gets a fresh identity on every list refetch — including the ones this hook
  // provokes by writing to the mirror.
  const signature = rows.map((r) => `${r.peer_id}@${r.last_at ?? ''}`).join(',');

  useEffect(() => {
    let alive = true;

    void (async () => {
      const cachedText = new Map<string, string | null>();
      const cachedAt = new Map<string, string | null>();
      for (const row of rows) {
        const hit = await cachedPreview(row.peer_id);
        cachedText.set(row.peer_id, hit?.text ?? null);
        cachedAt.set(row.peer_id, hit?.created_at ?? null);
      }
      if (!alive) return;
      // Published before the probes run: a list that paints a frame late is
      // worse than one line that resolves a moment after the rest.
      setPreviews(new Map(cachedText));

      if (!identity) return;
      const stale = stalePreviews(rows, cachedAt, attempted.current);
      if (stale.length === 0) return;

      const opened = await Promise.all(
        stale.map(async (peerId) => {
          const row = await fetchNewestMessage(me, peerId);
          if (!row) return [peerId, null] as const;
          attempted.current.add(previewProbeKey(peerId, row.created_at));
          // Mirrors the row as a side effect, which is the point of routing
          // through `openRows` rather than calling `openBody` directly.
          const [body] = await openRows(identity, await peerPublicKey(peerId), peerId, [row]);
          return [peerId, body?.text ?? null] as const;
        })
      );
      if (!alive) return;

      setPreviews((prev) => {
        const next = new Map(prev);
        for (const [peerId, text] of opened) if (text !== null) next.set(peerId, text);
        return next;
      });
    })();

    return () => {
      alive = false;
    };
    // `rows` is covered by `signature`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, me, identity]);

  return previews;
}
