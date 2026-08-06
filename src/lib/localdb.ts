// Decrypted message text, on the device only. This is what search and the
// conversation list read from once 0023 takes those capabilities away from
// Postgres. It holds plaintext at rest in app-private storage, which spec §7
// discloses rather than hides.
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

const DB_NAME = 'nearside-local';

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
/** Test and web-development driver. Native builds never touch this. */
const memory = new Map<string, CachedMessage>();

function native(): boolean {
  return Capacitor.isNativePlatform();
}

export async function openLocalDb(): Promise<void> {
  if (!native() || db) return;
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(SCHEMA);
}

export async function cacheMessage(row: CachedMessage): Promise<void> {
  if (!native()) {
    memory.set(row.id, row);
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
    const rows = [...memory.values()].filter((r) => r.peer_id === peerId).sort(NEWEST_FIRST);
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
    return [...memory.values()]
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

export async function clearLocalDb(): Promise<void> {
  memory.clear();
  if (native()) await db?.execute('DELETE FROM messages_cache');
}
