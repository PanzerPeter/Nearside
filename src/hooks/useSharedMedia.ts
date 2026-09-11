// Every picture and video in a conversation, for the panel's third tab.
//
// The other two tabs read the local mirror, because the server has held no
// message bodies since 0023 and a date or a link is a body. An attachment is
// not: the row keeps an object path and a file key sealed to the reader, so
// this one can ask the server and get the whole history back rather than the
// part of it this device happens to have decrypted.
//
// The rows arrive sealed, like every other read in the app, and are opened by
// the conversation's own decrypt boundary — see `ChatRoom.open`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMediaRows } from '../lib/message-queries';
import type { Message } from '../lib/types';

export interface SharedMedia {
  rows: Message[];
  loading: boolean;
  /** The server refused or could not be reached. The grid says so rather than
   *  showing the empty state, which here would be the wrong claim entirely:
   *  "no pictures" and "could not ask" look identical and are not. */
  failed: boolean;
}

/**
 * @param me the viewer
 * @param peerId the open conversation
 * @param enabled false while the tab is closed — this is a network round trip
 *   and a decrypt per row, and neither is worth spending until somebody asks
 * @param open the conversation's decrypt boundary (`ChatRoom.open`), for the
 *   same reason `useReplyTargets` takes one: peer-key resolution stays in the
 *   single place that owns it
 */
export function useSharedMedia(
  me: string,
  peerId: string,
  enabled: boolean,
  open: (rows: Message[]) => Promise<Message[]>
): SharedMedia {
  const [rows, setRows] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Through a ref, like `useReplyTargets`: `open` is a fresh arrow on every
  // render of the chat, and as a dependency it would re-fetch the whole grid
  // on each keystroke in the composer.
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setRows(await openRef.current(await fetchMediaRows(me, peerId)));
    } catch {
      setRows([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [me, peerId]);

  useEffect(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    void load();
  }, [enabled, load]);

  return { rows, loading, failed };
}
