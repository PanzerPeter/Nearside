// Optimistic text sends and the queue that makes them durable.
//
// Nothing the user can feel touches the network: the bubble appears and the
// composer clears before any round trip, and the message is in IndexedDB
// before `send` returns. Insert, retry, back-off and giving up all happen in
// `flush`.

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { supabase } from '../lib/supabase';
import { Message, PendingMessage } from '../lib/types';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { fetchOwnMessageRow } from '../lib/message-queries';
import { sealBody } from '../lib/sealed-body';
import { peerPublicKey } from '../lib/peer-keys';
import { notifyReceiver } from '../lib/push';
import type { Identity } from '../lib/crypto/keys';
import {
  bumpAttempts,
  dequeue,
  enqueue,
  isDuplicateSend,
  listFor,
  nextDelayMs,
  MAX_ATTEMPTS,
} from '../lib/outbox';

export interface Outbox {
  /** Sends not yet acknowledged by the server. Rendered after `messages`
   *  rather than merged into it — see `ChatRoom`. */
  pending: PendingMessage[];
  /** `pending`, readable from the realtime callbacks, which close over the
   *  state as it was when `subscribe` ran. */
  pendingRef: MutableRefObject<PendingMessage[]>;
  /** True for the moment `send` spends handing the message to IndexedDB. */
  sending: boolean;
  send: (text: string, replyToId: string | null) => Promise<void>;
  /** Drop settled messages from `pending`. Separate from `retire` so the
   *  adoption paths can pair it with a `messages` update in the same commit. */
  dropPending: (...ids: string[]) => void;
  /** Drop a settled message from whichever queue is holding it. */
  retire: (id: string) => Promise<void>;
  flush: () => Promise<void>;
}

interface OutboxOptions {
  me: string;
  peerId: string;
  identity: Identity;
  isSelf: boolean;
  /** The conversation the component currently has open. */
  loadedFor: MutableRefObject<string>;
  /** Bumped when the app wakes, giving a queue left behind by a dropped
   *  connection another go. */
  generation: number;
  /** The decrypt boundary, for reading back a row this client wrote. */
  open: (rows: Message[]) => Promise<Message[]>;
  /** Hand the authoritative row to the thread. Called immediately before
   *  `pending` is trimmed, with no `await` in between. See `flush`. */
  onAdopt: (row: Message) => void;
  /** Run once the optimistic bubble exists: clear the composer, drop the reply
   *  target, take focus back. */
  onQueued: () => void;
  onError: (message: string) => void;
}

export function useOutbox({
  me,
  peerId,
  identity,
  isSelf,
  loadedFor,
  generation,
  open,
  onAdopt,
  onQueued,
  onError,
}: OutboxOptions): Outbox {
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sending, setSending] = useState(false);

  const pendingRef = useRef<PendingMessage[]>(pending);
  // Messages `enqueue` could not persist (IndexedDB unavailable or denied).
  // They never appear in `listFor`, so without this the composer would show a
  // "pending" bubble that is never sent, retried or failed. Reset with
  // `pending` on a conversation switch; nothing here is durable across one.
  const unqueuedRef = useRef<Map<string, PendingMessage>>(new Map());
  // Which conversation's queue the pending timer will flush. Keyed rather than
  // a bare boolean so a switch mid-flush doesn't make the new conversation's
  // mount-flush a no-op.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushInFlightFor = useRef<string | null>(null);
  // Set when a flush is asked for while one is already running, so the running
  // pass re-runs once instead of the request being lost.
  const flushAgainFor = useRef<string | null>(null);

  // In an effect rather than inline during render: a ref write belongs in the
  // commit phase, which runs once per commit rather than once per render body.
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    setPending([]);
    unqueuedRef.current = new Map();
    flushAgainFor.current = null;
  }, [peerId]);

  useEffect(() => {
    void flush();

    const handleOnline = () => void flush();
    window.addEventListener('online', handleOnline);

    return () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, generation]);

  async function send(text: string, replyToId: string | null): Promise<void> {
    if (!text) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      onError(`Message is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }

    setSending(true);
    // The local clock only orders this bubble among this session's own
    // optimistic sends. It never reaches a receipt comparison: the row is
    // discarded once the server's insert arrives with its own `created_at`.
    const msg: PendingMessage = {
      id: crypto.randomUUID(),
      user_id: me,
      receiver_id: peerId,
      text,
      reply_to_id: replyToId,
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    setPending((p) => [...p, msg]);
    onQueued();
    const persisted = await enqueue(msg);
    // IndexedDB unavailable or denied. `flush` reads `listFor`, so an
    // uncaptured message would sit on screen as "pending" forever. Tracked
    // here so it is still attempted, retried and failed like any other.
    if (!persisted) unqueuedRef.current.set(msg.id, msg);
    setSending(false);
    void flush();
  }

  /**
   * The only place a message is inserted. Returns the authoritative row rather
   * than a boolean, so the caller can swap it in for the optimistic bubble.
   *
   * The insert carries the queued message's uuid as the row's primary key,
   * which is what makes sending idempotent. Without it a send whose *response*
   * was lost looks identical to one that never arrived, and the retry writes a
   * second copy: the duplicate message everyone sees on a flaky link. With it
   * the retry collides, and the collision is read here as the delivery it was.
   */
  async function attemptSend(msg: PendingMessage): Promise<Message | null> {
    try {
      const { data: inserted, error: insertError } = await supabase
        .from('messages')
        .insert({
          id: msg.id,
          user_id: msg.user_id,
          receiver_id: msg.receiver_id,
          ...(await sealBody(
            identity,
            await peerPublicKey(msg.receiver_id),
            msg.user_id,
            msg.receiver_id,
            msg.text
          )),
          reply_to_id: msg.reply_to_id,
        })
        .select('*')
        .single();

      if (isDuplicateSend(insertError)) {
        const row = await fetchOwnMessageRow(me, msg.id);
        // Null is an ordinary failed attempt: the send retries, hits the same
        // collision and tries again, which is harmless.
        if (!row) return null;
        // The row landed but its response never did, so nobody asked for the
        // push either. This retry is the first chance to send it.
        notifyReceiver(row.id, isSelf);
        const [opened] = await open([row]);
        return opened;
      }
      // Some stacks reject an offline fetch rather than resolving with an
      // `error` field. The outbox exists for exactly this case, so a thrown
      // network error is an ordinary failure, not an unhandled rejection.
      if (insertError || !inserted) return null;
      notifyReceiver(inserted.id, isSelf);
      const [opened] = await open([inserted as Message]);
      return opened;
    } catch {
      return null;
    }
  }

  function scheduleFlush(delayMs: number) {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flush();
    }, delayMs);
  }

  /** In-memory `bumpAttempts` for a message the outbox never captured (see
   *  `unqueuedRef`). Same shape and same null-when-gone contract, so `flush`
   *  treats durable and non-durable entries identically. */
  function bumpUnqueued(msg: PendingMessage): PendingMessage | null {
    const current = unqueuedRef.current.get(msg.id);
    if (!current) return null;
    const updated: PendingMessage = { ...current, attempts: current.attempts + 1 };
    unqueuedRef.current.set(msg.id, updated);
    return updated;
  }

  function dropPending(...ids: string[]) {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    setPending((prev) => prev.filter((m) => !drop.has(m.id)));
  }

  /** Both halves are no-ops when the entry isn't there, so the realtime
   *  adoption paths can call this without knowing which queue captured it. */
  async function retire(id: string): Promise<void> {
    unqueuedRef.current.delete(id);
    await dequeue(id);
  }

  /**
   * Drain this conversation's queue: attempt every entry, dequeue and drop it
   * from `pending` on success, bump its attempt count on failure, give up and
   * toast at `MAX_ATTEMPTS`. A delivered message is not pushed into `messages`
   * here; the realtime INSERT carries the authoritative row.
   *
   * Two disjoint sources feed the attempt list: IndexedDB via `listFor`, and
   * `unqueuedRef` for what `send` could not persist there. `send` files a
   * given id in exactly one of them, so attempting both cannot double-send.
   *
   * The guard is per conversation rather than a single flag, so a slow flush
   * for a chat you have left doesn't block the new one's mount-flush. Durable
   * writes run unconditionally, since they touch storage rather than the
   * screen; only `setPending` and the error toast are gated behind
   * `loadedFor`. Do not collapse these into one gate: gating the durable write
   * too meant a success landing as the user switched away was never dequeued,
   * and the next flush re-sent it as a duplicate row.
   */
  async function flush(): Promise<void> {
    const forFriend = peerId;
    // A flush already running snapshotted the queue before whatever prompted
    // this call, so the new work is invisible to it. Ask for one more pass
    // rather than dropping the request and stranding a queued message.
    if (flushInFlightFor.current === forFriend) {
      flushAgainFor.current = forFriend;
      return;
    }
    flushInFlightFor.current = forFriend;

    try {
      const queued = await listFor(me, forFriend);
      if (loadedFor.current !== forFriend) return;
      // Seeds `pending` with anything that survived a reload. The mount flush
      // is the only trigger with no prior `send` call to have added these.
      setPending((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const additions = queued.filter((m) => !known.has(m.id));
        return additions.length ? [...prev, ...additions] : prev;
      });

      const attemptList: Array<{ msg: PendingMessage; durable: boolean }> = [
        ...queued.map((msg) => ({ msg, durable: true })),
        ...[...unqueuedRef.current.values()].map((msg) => ({ msg, durable: false })),
      ];

      const stillQueued: PendingMessage[] = [];
      for (const { msg, durable } of attemptList) {
        const row = await attemptSend(msg);
        const onScreen = loadedFor.current === forFriend;

        if (row) {
          // Both updates in one commit, no `await` between: split across two
          // commits, either ordering is visible at 60fps. Dropping `pending`
          // first blinks the bubble out and back, adding the row first paints
          // the message twice. `dequeue` waits for the same reason, and a
          // moment's delay there is invisible.
          if (onScreen) {
            onAdopt(row);
            dropPending(msg.id);
          }
          if (durable) await dequeue(msg.id);
          else unqueuedRef.current.delete(msg.id);
          continue;
        }

        // A rate-limit rejection lands here too and consumes an attempt like
        // any other failure, so a flush against that limit backs off rather
        // than spinning on it.
        const updated: PendingMessage | null = durable
          ? await bumpAttempts(msg.id)
          : bumpUnqueued(msg);

        // Gone from the queue mid-attempt: the server row arrived over
        // realtime and the adoption path retired it. Delivered, not failed, so
        // there is nothing to retry and nothing to report.
        if (!updated) continue;

        if (updated.attempts >= MAX_ATTEMPTS) {
          if (durable) await dequeue(msg.id);
          else unqueuedRef.current.delete(msg.id);
          if (onScreen) {
            dropPending(msg.id);
            onError('Message failed to send.');
          }
          continue;
        }

        if (onScreen) {
          setPending((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
          stillQueued.push(updated);
        }
      }

      if (stillQueued.length > 0) {
        const lowestAttempts = Math.min(...stillQueued.map((m) => m.attempts));
        scheduleFlush(nextDelayMs(lowestAttempts));
      }
    } finally {
      if (flushInFlightFor.current === forFriend) flushInFlightFor.current = null;
      // Serve whatever asked for a flush while this one held the lock, once
      // per coalesced burst. The flag is cleared before the recursive call, so
      // a pass with nothing to do ends the chain rather than looping.
      if (flushAgainFor.current === forFriend) {
        flushAgainFor.current = null;
        if (loadedFor.current === forFriend) void flush();
      }
    }
  }

  return { pending, pendingRef, sending, send, dropPending, retire, flush };
}
