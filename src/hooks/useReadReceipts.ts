// Delivery and read watermarks for the open conversation: the peer's, which
// paints the ticks on your own messages, and yours, which you advance by
// looking at the chat.

import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { Message } from '../lib/types';
import { advanceRead, fetchMyReadAt, fetchPeerReceipt, type Receipt } from '../lib/receipts';
import { closeNotificationsFor } from '../lib/notifications';

export interface ReadReceipts {
  /** The peer's watermarks, or null until they have one. */
  peerReceipt: Receipt | null;
  /** How far this account had read when the conversation opened, or null when
   *  it never had. `undefined` while that read is still in flight — the "new
   *  messages" line has to wait for it rather than guess, and so does the first
   *  write of our own watermark. */
  readAtOnOpen: string | null | undefined;
  /** Apply a row delivered over realtime. React's own setter, so the realtime
   *  handler's long-lived closure can hold it without going stale. */
  setPeerReceipt: Dispatch<SetStateAction<Receipt | null>>;
}

interface ReadReceiptsOptions {
  peerId: string;
  /** Your own notes: a receipt row for (me, me) is forbidden outright by
   *  `no_self_receipt`, so every write here would only ever be rejected. */
  isSelf: boolean;
  /** The loaded window, scanned for the newest message the peer has sent. */
  messages: Message[];
  /** The conversation the component currently has open, so a fetch that
   *  outlives a switch doesn't paint the wrong chat's receipt. */
  loadedFor: MutableRefObject<string>;
  /** Bumped when the app wakes; the peer may have read everything while this
   *  client was asleep and the realtime event for it is long gone. */
  generation: number;
}

export function useReadReceipts({
  peerId,
  isSelf,
  messages,
  loadedFor,
  generation,
}: ReadReceiptsOptions): ReadReceipts {
  const [peerReceipt, setPeerReceipt] = useState<Receipt | null>(null);
  // Where this account had read up to before opening. Captured *before* the
  // effect below advances it: reading it afterwards always answers "nothing
  // new", which is exactly how an unread line quietly stops appearing.
  const [readAtOnOpen, setReadAtOnOpen] = useState<string | null | undefined>(undefined);
  // The `created_at` last written to our read watermark for this conversation.
  // `messages` changes on every send, page load, and realtime edit/delete, and
  // the peer subscribes to `message_receipts` with `event: '*'` — so a
  // same-value re-write isn't a no-op locally, it's a spurious re-render fired
  // at them. Skip the call unless the watermark would actually advance.
  const lastReadSent = useRef<string | null>(null);

  useEffect(() => {
    lastReadSent.current = null;
    setPeerReceipt(null);
  }, [peerId]);

  // One read per conversation, not per wake: the point is what was unread when
  // this view opened, and a `generation` bump does not reopen it.
  useEffect(() => {
    if (isSelf) {
      // Your own notes have no watermark and no other side to have missed.
      setReadAtOnOpen(null);
      return;
    }
    let cancelled = false;
    const forPeer = peerId;
    setReadAtOnOpen(undefined);
    void (async () => {
      const at = await fetchMyReadAt(forPeer);
      if (cancelled || loadedFor.current !== forPeer) return;
      setReadAtOnOpen(at);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, isSelf]);

  useEffect(() => {
    if (isSelf) return;
    let cancelled = false;
    const forPeer = peerId;
    void (async () => {
      const row = await fetchPeerReceipt(forPeer);
      if (cancelled || loadedFor.current !== forPeer) return;
      setPeerReceipt(row);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, isSelf, generation]);

  // Reading is what the open, focused chat means. Re-run on refocus so a
  // message that arrived while the window was in the background is only
  // marked read once you actually come back to it.
  useEffect(() => {
    const mark = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      markReadHere();
      // Reading the chat retires its notifications. Without this, banners for
      // messages plainly visible on screen stay stacked in the OS tray (and
      // keep the taskbar/dock icon lit) until dismissed by hand.
      void closeNotificationsFor(`dm:${peerId}`);
    };

    /**
     * Advance my read watermark to the newest message this friend has sent.
     * Anchored to a server-stamped `created_at` rather than the local clock —
     * the watermark is compared against that same column.
     */
    function markReadHere() {
      if (isSelf) return;
      // Nothing is marked read until the baseline above has been captured,
      // otherwise this write is the one that erases it.
      if (readAtOnOpen === undefined) return;
      const newestInbound = [...messages].reverse().find((m) => m.user_id === peerId);
      if (!newestInbound) return;
      if (newestInbound.created_at === lastReadSent.current) return;
      lastReadSent.current = newestInbound.created_at;
      void advanceRead(peerId, newestInbound.created_at);
    }

    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [messages, peerId, isSelf, readAtOnOpen]);

  return { peerReceipt, setPeerReceipt, readAtOnOpen };
}
