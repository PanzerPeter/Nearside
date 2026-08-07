// Decrypted message text, on the device only. This is what search and the
// conversation list read from once 0023 takes those capabilities away from
// Postgres. It holds plaintext at rest in app-private storage, which spec §7
// discloses rather than hides.
//
// One store per account, never one per device: two people sharing a phone must
// not find each other's decrypted messages in their own search results.
import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';

export interface CachedMessage {
  id: string;
  peer_id: string;
  user_id: string;
  text: string;
  created_at: string;
}

/** The database file is named for the account, so the isolation is the
 *  filesystem's rather than a WHERE clause somebody can forget to write. */
const dbName = (userId: string) => `nearside-local-${userId}`;

/** Newest first, the order both drivers return rows in. */
const NEWEST_FIRST = (a: CachedMessage, b: CachedMessage) =>
  a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;

const SEARCH_LIMIT = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_cache (
  id         TEXT PRIMARY KEY,
  peer_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_cache_peer_time
  ON messages_cache (peer_id, created_at DESC);
`;

let db: SQLiteDBConnection | null = null;
/** Whose store is currently open. Reads and writes with no owner are no-ops:
 *  writing to the last account's store because this one has not opened yet is
 *  the exact leak the scoping exists to prevent. */
let owner: string | null = null;
/** Test and web-development driver. Native builds never touch this. */
const memory = new Map<string, Map<string, CachedMessage>>();

function native(): boolean {
  return Capacitor.isNativePlatform();
}

function memoryStore(): Map<string, CachedMessage> | null {
  if (!owner) return null;
  let store = memory.get(owner);
  if (!store) {
    store = new Map();
    memory.set(owner, store);
  }
  return store;
}

/** Opens the store belonging to `userId`, closing whichever one was open. */
export async function openLocalDb(userId: string): Promise<void> {
  if (owner === userId && (db || !native())) return;

  if (native()) {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    if (db && owner) {
      await db.close();
      await sqlite.closeConnection(dbName(owner), false);
      db = null;
    }
    owner = userId;
    db = await sqlite.createConnection(dbName(userId), false, 'no-encryption', 1, false);
    await db.open();
    await db.execute(SCHEMA);
    return;
  }
  owner = userId;
}

export async function cacheMessage(row: CachedMessage): Promise<void> {
  if (!native()) {
    memoryStore()?.set(row.id, row);
    return;
  }
  await db?.run(
    `INSERT INTO messages_cache (id, peer_id, user_id, text, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
    [row.id, row.peer_id, row.user_id, row.text, row.created_at]
  );
}

export async function cachedPreview(peerId: string): Promise<CachedMessage | null> {
  if (!native()) {
    const rows = [...(memoryStore()?.values() ?? [])]
      .filter((r) => r.peer_id === peerId)
      .sort(NEWEST_FIRST);
    return rows[0] ?? null;
  }
  const res = await db?.query(
    'SELECT * FROM messages_cache WHERE peer_id = ? ORDER BY created_at DESC LIMIT 1',
    [peerId]
  );
  return (res?.values?.[0] as CachedMessage) ?? null;
}

export async function searchCached(peerId: string, query: string): Promise<CachedMessage[]> {
  const needle = query.trim();
  if (!needle) return [];

  if (!native()) {
    // The two drivers must agree on ordering and cap as well as on matching —
    // a difference here is a bug the test suite could never see, because the
    // suite only ever runs this branch.
    const lowered = needle.toLowerCase();
    return [...(memoryStore()?.values() ?? [])]
      .filter((r) => r.peer_id === peerId && r.text.toLowerCase().includes(lowered))
      .sort(NEWEST_FIRST)
      .slice(0, SEARCH_LIMIT);
  }
  // ESCAPE, so a user searching for "50% off" does not match "50X off" — the
  // same trap 0010 documented on the server side.
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const res = await db?.query(
    `SELECT * FROM messages_cache
     WHERE peer_id = ? AND text LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT ${SEARCH_LIMIT}`,
    [peerId, `%${escaped}%`]
  );
  return (res?.values as CachedMessage[]) ?? [];
}

/** Empties the open account's store. Signing out must not take the other
 *  account's messages with it. */
export async function clearLocalDb(): Promise<void> {
  if (!native()) {
    memoryStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
}
