// The offline outbox: text messages the composer has accepted but the
// server hasn't acknowledged yet. Persisted to IndexedDB so a reload — or the
// app closing entirely while offline — doesn't silently drop them; ChatRoom's
// flush loop resumes the queue on mount and on reconnect.
//
// Every export here degrades to a safe empty value instead of throwing or
// rejecting. IndexedDB can be missing outright (this module is also imported
// by node-run unit tests) or throw when a private-browsing tab has denied
// storage — either way the contract with the composer is "sending still
// works, queueing just quietly doesn't," never a crash.

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
 * A queued message carries its own uuid and sends it as the row's primary
 * key, which makes the insert idempotent: a retry of a send whose response
 * was lost (dropped socket, frozen tab, timeout) collides with the row it
 * already created instead of writing a second copy. Recognising that
 * collision is what lets the caller treat the retry as the success it
 * actually is, rather than as a failure to retry again.
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
 * Persist a message to the queue. Returns whether the write actually landed
 * in IndexedDB — `false` covers both "no store at all" (private browsing,
 * storage denied) and a `put` that failed inside a live store. Callers need
 * this rather than a fire-and-forget `void`: a message the outbox couldn't
 * take custody of has to be sent some other way, or it never leaves the
 * screen at all (see `ChatRoom.flushOutbox`'s `unqueuedRef` path).
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
 * Drop every queued message on this device. Called when a session ends: an
 * unsent body is message content, and leaving it in IndexedDB outlives both
 * sign-out and account deletion, which is the one case where the data is
 * supposed to be gone for good.
 */
export async function clearAll(): Promise<void> {
  await withStore<void>('readwrite', undefined, (store, resolve) => {
    const req = store.clear();
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => resolve(undefined);
  });
}

/**
 * Everything queued from `me` to `peerId`. The store only indexes
 * `receiver_id` — at personal scale (<50 accounts, one outbox per device) an
 * in-memory filter for `user_id` on top of that is cheaper than a compound
 * index would be worth. Sorted oldest-first so the flush loop retries in
 * send order.
 */
export async function listFor(me: string, peerId: string): Promise<PendingMessage[]> {
  const rows = await withStore<PendingMessage[]>('readonly', [], (store, resolve) => {
    const req = store.index(RECEIVER_INDEX).getAll(peerId);
    req.onsuccess = () => resolve((req.result as PendingMessage[]) ?? []);
    req.onerror = () => resolve([]);
  });
  return rows
    .filter((m) => m.user_id === me)
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
      const updated: PendingMessage = { ...existing, attempts: existing.attempts + 1 };
      const putReq = store.put(updated);
      putReq.onsuccess = () => resolve(updated);
      putReq.onerror = () => resolve(null);
    };
    getReq.onerror = () => resolve(null);
  });
}
