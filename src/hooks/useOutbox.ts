// Optimistic text sends and the queue that makes them durable.
//
// A text send never touches the network on the path the user can feel: the
// bubble appears and the composer clears before any round trip, and the
// message is in IndexedDB before `send` returns. Everything after that —
// insert, retry, back-off, giving up — happens in `flush`.

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
  /** `pending`, readable from the realtime callbacks — those close over the
   *  state as it was when `subscribe` ran, which for a long-lived channel is
   *  almost never the current one. */
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
  /** Bumped when the app wakes: a queue left behind by a dropped connection
   *  gets another go. */
  generation: number;
  /** The conversation's decrypt boundary, for reading back a row this client
   *  wrote. */
  open: (rows: Message[]) => Promise<Message[]>;
  /** Hand the authoritative row to the thread. Called immediately before
   *  `pending` is trimmed, and with no `await` in between — see `flush`. */
  onAdopt: (row: Message) => void;
  /** Run the moment the optimistic bubble exists: clear the composer, drop the
   *  reply target, take focus back. */
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
  // Messages `enqueue` could not persist (IndexedDB unavailable or denied),
  // keyed by id. These never appear in `listFor`'s results, so without this
  // `flush` would never attempt them at all — the composer would show a
  // "pending" bubble that is never sent, retried, or failed. Reset alongside
  // `pending` on every conversation switch, since nothing in here is durable
  // across one anyway.
  const unqueuedRef = useRef<Map<string, PendingMessage>>(new Map());
  // The pending timer, and which conversation's queue it will flush. Keyed
  // rather than a bare boolean so a switch mid-flush doesn't make the new
  // conversation's own mount-flush a no-op — see `flush`.
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushInFlightFor = useRef<string | null>(null);
  // Set when a flush is asked for while one is already running for the same
  // conversation, so the running pass re-runs once instead of the request
  // being lost — see `flush`.
  const flushAgainFor = useRef<string | null>(null);

  // Written from an effect, not inline during render: a ref write belongs in
  // the commit phase, which runs once per commit rather than once per
  // render-body invocation.
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
    // optimistic sends — it never reaches a receipt comparison, because the
    // row is discarded the moment the server's `messages` insert (with its
    // own, authoritative `created_at`) arrives over realtime and replaces it.
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
    // IndexedDB unavailable or denied: the outbox can't take custody of this
    // message, so `flush` would never see it via `listFor` and it would sit on
    // screen as "pending" forever. Track it here instead so `flush` still
    // attempts (and retries, and can fail) it directly.
    if (!persisted) unqueuedRef.current.set(msg.id, msg);
    setSending(false);
    void flush();
  }

  /**
   * The insert the composer used to make directly, now made only from the
   * queue. Returns the authoritative row (not just `true`) so the caller can
   * swap it in for the optimistic bubble itself.
   *
   * The insert carries the queued message's own uuid as the row's primary
   * key, which is what makes sending idempotent. Without it, a send whose
   * *response* was lost — a dropped connection, a frozen tab, a timeout —
   * looked identical to one that never reached the server at all, and the
   * retry wrote a second copy: the "message sent twice" everyone sees on a
   * flaky link. With it, the retry collides with the row it already created,
   * and that collision is read here as the delivery it actually was.
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
        // A null here is treated as an ordinary failed attempt — the send is
        // retried, hits the same collision, and tries again, which is
        // harmless.
        if (!row) return null;
        // The row landed but its response never did, so the push for it was
        // never asked for either — this retry is the first chance to send it.
        notifyReceiver(row.id, isSelf);
        const [opened] = await open([row]);
        return opened;
      }
      // Genuinely offline fetches reject rather than resolving with an
      // `error` field on some stacks — the outbox exists specifically for
      // this case, so treat a thrown network error as an ordinary failure
      // rather than letting it escape as an unhandled rejection.
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

  /** In-memory equivalent of `bumpAttempts`, for a message the outbox never
   *  captured (see `unqueuedRef`) — same shape, so `flush` can treat a durable
   *  and a non-durable entry identically apart from where the new attempt
   *  count is written. Null when the entry has left the queue meanwhile,
   *  matching what `bumpAttempts` reports for the same case. */
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

  /** Both halves are no-ops when the entry isn't there, so callers that don't
   *  know which queue captured it (the realtime adoption paths) can just call
   *  this. */
  async function retire(id: string): Promise<void> {
    unqueuedRef.current.delete(id);
    await dequeue(id);
  }

  /**
   * Drain this conversation's queue: attempt every entry, dequeue and drop
   * from `pending` on success, or bump its attempt count on failure — giving
   * up (and toasting) once `MAX_ATTEMPTS` is reached. A message that reaches
   * the server is *not* pushed into `messages` here; the realtime INSERT
   * delivers the authoritative row and `mergeMessages` de-dupes it.
   *
   * Two sources feed the attempt list: the entries read from IndexedDB via
   * `listFor`, and `unqueuedRef`, messages `send` couldn't persist there at
   * all (storage denied, private browsing). They're disjoint by construction —
   * `send` puts a given message's id in exactly one of them — so attempting
   * both here can't double-send; it's what keeps a message going out even when
   * the outbox itself is unavailable.
   *
   * Guarded per-conversation (not with a single flag) so a slow flush for a
   * conversation you've since left doesn't block the new one's mount-flush.
   * Durable writes (`dequeue`, `bumpAttempts`, and the `unqueuedRef`
   * mutations that stand in for them) run unconditionally — they only touch
   * storage local to this function, not the screen, so they're correct
   * regardless of which conversation is open. Only the React state updates
   * (`setPending`, the error toast) are gated behind `loadedFor`, since those
   * alone paint *this* screen. Do not "simplify" this back to one shared gate:
   * it used to gate the durable write too, so a success landing exactly as the
   * user switched conversations away never got dequeued — the next flush
   * re-sent it and produced a duplicate row on the server.
   */
  async function flush(): Promise<void> {
    const forFriend = peerId;
    // A flush already reading this conversation's queue snapshotted it before
    // whatever prompted this call — a fresh `send`, a reconnect — so the new
    // work is invisible to it. Ask for one more pass instead of dropping the
    // request on the floor, which used to leave a message queued behind a
    // concurrent flush with nothing left to retry it.
    if (flushInFlightFor.current === forFriend) {
      flushAgainFor.current = forFriend;
      return;
    }
    flushInFlightFor.current = forFriend;

    try {
      const queued = await listFor(me, forFriend);
      if (loadedFor.current !== forFriend) return;
      // Seeds `pending` with anything that survived a reload — the mount
      // flush is the only trigger with no prior `send` call to have added
      // these already.
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
          // Both updates in one commit, with no `await` between them: either
          // ordering split across two commits is visible at 60fps. Dropping
          // `pending` first blinks the bubble out and back; adding the row
          // first paints the same message twice. The durable write comes
          // after for the same reason — `dequeue` is an await, and dequeuing
          // a moment later is invisible either way.
          if (onScreen) {
            onAdopt(row);
            dropPending(msg.id);
          }
          if (durable) await dequeue(msg.id);
          else unqueuedRef.current.delete(msg.id);
          continue;
        }

        // A rate-limit rejection lands here too: it consumes an attempt like
        // any other failure rather than being retried immediately, so a
        // flush against that limit backs off instead of spinning on it.
        const updated: PendingMessage | null = durable
          ? await bumpAttempts(msg.id)
          : bumpUnqueued(msg);

        // Gone from the queue while this attempt was in flight: its server
        // row arrived over realtime and the adoption path retired it. The
        // message is delivered — not failed — so there is nothing to retry
        // and nothing to tell the user about.
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
      // Serve whatever asked for a flush while this one held the lock. Only
      // for the conversation still on screen, and only once per coalesced
      // burst — the flag is cleared before the recursive call, so a pass that
      // finds nothing to do ends the chain rather than looping.
      if (flushAgainFor.current === forFriend) {
        flushAgainFor.current = null;
        if (loadedFor.current === forFriend) void flush();
      }
    }
  }

  return { pending, pendingRef, sending, send, dropPending, retire, flush };
}
