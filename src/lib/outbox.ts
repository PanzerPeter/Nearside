// The offline outbox: text messages the composer has accepted and the server
// has not acknowledged. Persisted to IndexedDB so a reload, or the app closing
// while offline, does not drop them silently. `useOutbox`'s flush loop resumes
// the queue on mount and on reconnect.
//
// Every export degrades to a safe empty value rather than throwing. IndexedDB
// can be missing outright, as it is under the node test runner, or throw when
// a private-browsing tab denies storage. The contract with the composer is
// that sending still works and queueing quietly does not, never a crash.

import { PendingMessage } from './types';

const DB_NAME = 'nearside-outbox';
const DB_VERSION = 1;
const STORE = 'pending';
const RECEIVER_INDEX = 'receiver_id';

export const MAX_ATTEMPTS = 5;

/**
 * Exponential backoff starting at one second, capped at thirty so a long
 * offline stretch doesn't stall the queue behind an ever-growing wait.
 */
export function nextDelayMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 30_000);
}

/**
 * Postgres' unique-violation SQLSTATE, surfaced by PostgREST on the `code`
 * field of an insert error.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * Did this insert fail *because the row is already there*?
 *
 * A queued message sends its own uuid as the row's primary key, which makes
 * the insert idempotent: a retry of a send whose response was lost collides
 * with the row it already created instead of writing a second copy.
 * Recognising that collision is what lets the caller treat the retry as the
 * success it is.
 */
export function isDuplicateSend(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // `code` is authoritative; the message check is a fallback for stacks that
  // surface the error as a bare string without the SQLSTATE alongside it.
  return error.code === UNIQUE_VIOLATION || /duplicate key value/i.test(error.message ?? '');
}

function openDb(): Promise<IDBDatabase | null> {
  // Absent in some privacy modes and in the node test environment — neither
  // is an error, just a signal to skip persistence entirely.
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Some browsers throw synchronously from `open` itself when storage is
      // denied, rather than failing the request asynchronously.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(RECEIVER_INDEX, 'receiver_id', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/**
 * Run one transaction against the `pending` store, resolving `fallback` on
 * any failure — open error, transaction abort, or a synchronous throw from a
 * request call — so a caller never has to catch this itself.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  fallback: T,
  run: (store: IDBObjectStore, resolve: (value: T) => void) => void
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const tx = db.transaction(STORE, mode);
      tx.onerror = () => settle(fallback);
      tx.onabort = () => settle(fallback);
      run(tx.objectStore(STORE), settle);
    } catch {
      settle(fallback);
    }
  });
}

/**
 * Persist a message to the queue. Returns whether the write landed in
 * IndexedDB: `false` covers both no store at all and a `put` that failed
 * inside a live one. Callers need this rather than a fire-and-forget `void`,
 * because a message the outbox could not take custody of has to be sent some
 * other way or it never leaves the screen. See `useOutbox.flush`.
 */
export async function enqueue(msg: PendingMessage): Promise<boolean> {
  return withStore<boolean>('readwrite', false, (store, resolve) => {
    const req = store.put(msg);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

export async function dequeue(id: string): Promise<void> {
  await withStore<void>('readwrite', undefined, (store, resolve) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => resolve(undefined);
  });
}

/**
 * Whether a queued row belongs to `userId`.
 *
 * The store is one database per *device*, not per account — an unsent body is
 * addressed to a peer and the index is on `receiver_id`, so the account that
 * wrote it is only ever a field. Every read and every delete therefore has to
 * apply this itself, and they share the one definition so they cannot drift:
 * a `listFor` that scoped and a clear that did not is how one account's
 * sign-out came to discard another's queue.
 */
export function belongsTo(msg: PendingMessage, userId: string): boolean {
  return msg.user_id === userId;
}

/**
 * Drop everything `userId` has queued on this device, when their session ends.
 * An unsent body is message content, and left in IndexedDB it outlives both
 * sign-out and account deletion, the one case where the data is meant to be
 * gone for good.
 *
 * Scoped to the one account, and not `store.clear()`, because the database is
 * device-wide while everything it holds is not. A second account signed in on
 * the same phone keeps its own queue: it is not being signed out, its messages
 * have not been sent, and nothing tells it they were dropped.
 *
 * A cursor rather than the `receiver_id` index — that index answers "to whom",
 * and the question here is "from whom".
 */
export async function clearFor(userId: string): Promise<void> {
  await withStore<void>('readwrite', undefined, (store, resolve) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(undefined);
        return;
      }
      if (belongsTo(cursor.value as PendingMessage, userId)) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => resolve(undefined);
  });
}

/**
 * Everything queued from `me` to `peerId`. The store indexes `receiver_id`
 * only; at one outbox per device an in-memory filter for `user_id` costs less
 * than a compound index is worth. Sorted oldest first, so the flush loop
 * retries in send order.
 */
export async function listFor(me: string, peerId: string): Promise<PendingMessage[]> {
  const rows = await withStore<PendingMessage[]>('readonly', [], (store, resolve) => {
    const req = store.index(RECEIVER_INDEX).getAll(peerId);
    req.onsuccess = () => resolve((req.result as PendingMessage[]) ?? []);
    req.onerror = () => resolve([]);
  });
  return rows
    .filter((m) => belongsTo(m, me))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export async function bumpAttempts(id: string): Promise<PendingMessage | null> {
  return withStore<PendingMessage | null>('readwrite', null, (store, resolve) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as PendingMessage | undefined;
      if (!existing) {
        resolve(null);
        return;
      }
      const attempts = existing.attempts + 1;
      // The row that runs out of attempts is marked, not deleted. `flush`
      // reads the mark and leaves it alone; the bubble reads it and offers a
      // retry. This is the whole of the fix for a message that used to be
      // erased at the end of its backoff, with a toast the sender only saw if
      // they happened to still be looking at that conversation.
      const updated: PendingMessage = {
        ...existing,
        attempts,
        failed: attempts >= MAX_ATTEMPTS,
      };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => resolve(null);
    };
    getReq.onerror = () => resolve(null);
  });
}

/**
 * Put a failed message back in the queue for another go: attempts reset, mark
 * cleared. Returns the revived row, or null if it is no longer there — which
 * is what a message that arrived over realtime in the meantime looks like.
 */
export async function reviveQueued(id: string): Promise<PendingMessage | null> {
  return withStore<PendingMessage | null>('readwrite', null, (store, resolve) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as PendingMessage | undefined;
      if (!existing) {
        resolve(null);
        return;
      }
      const updated: PendingMessage = { ...existing, attempts: 0, failed: false };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => resolve(null);
    };
    getReq.onerror = () => resolve(null);
  });
}

/** Whether the flush loop should attempt this row. A failed message waits for
 *  the user, so that a queue holding one does not spin against whatever is
 *  refusing it every time the app wakes. */
export function isAttemptable(msg: PendingMessage): boolean {
  return !msg.failed;
}
