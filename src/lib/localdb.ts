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

/** A pinned attachment: the plaintext bytes are on this device, at
 *  `file_path`, and the server copy may be pruned at any time. Local only —
 *  a pin is a promise this phone makes, not one the server keeps. */
export interface PinnedMedia {
  message_id: string;
  file_path: string;
  pinned_at: string;
}

/** A peer's public key as this device first saw it, and whether a human ever
 *  confirmed it. Local only (spec §7): a server-held "verified" flag would be
 *  a claim from the party the verification exists to distrust. */
export interface CachedContact {
  peer_id: string;
  /** Base64, exactly as `profiles.public_key` stores it — compared as a
   *  string so a key change is a string inequality rather than a byte walk. */
  public_key: string;
  verified_at: string | null;
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

CREATE TABLE IF NOT EXISTS contacts (
  peer_id      TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  verified_at  TEXT
);

CREATE TABLE IF NOT EXISTS pins (
  message_id TEXT PRIMARY KEY,
  file_path  TEXT NOT NULL,
  pinned_at  TEXT NOT NULL
);
`;

let db: SQLiteDBConnection | null = null;
/** Whose store is currently open. Reads and writes with no owner are no-ops:
 *  writing to the last account's store because this one has not opened yet is
 *  the exact leak the scoping exists to prevent. */
let owner: string | null = null;
/** Test and web-development drivers. Native builds never touch these. */
const memory = new Map<string, Map<string, CachedMessage>>();
const contactMemory = new Map<string, Map<string, CachedContact>>();
const pinMemory = new Map<string, Map<string, PinnedMedia>>();

function native(): boolean {
  return Capacitor.isNativePlatform();
}

function scoped<T>(stores: Map<string, Map<string, T>>): Map<string, T> | null {
  if (!owner) return null;
  let store = stores.get(owner);
  if (!store) {
    store = new Map();
    stores.set(owner, store);
  }
  return store;
}

function memoryStore(): Map<string, CachedMessage> | null {
  return scoped(memory);
}

function contactStore(): Map<string, CachedContact> | null {
  return scoped(contactMemory);
}

function pinStore(): Map<string, PinnedMedia> | null {
  return scoped(pinMemory);
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
    // The whole script, every open, not a versioned upgrade path. That is what
    // gives a device already running an older build the `contacts` table: the
    // connection version stays 1, so a bump would never fire, but every
    // statement here is CREATE ... IF NOT EXISTS and re-running them is free.
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

/** The contact as this device last recorded it, or null if never seen. */
export async function cachedContact(peerId: string): Promise<CachedContact | null> {
  if (!native()) return contactStore()?.get(peerId) ?? null;
  const res = await db?.query('SELECT * FROM contacts WHERE peer_id = ?', [peerId]);
  return (res?.values?.[0] as CachedContact) ?? null;
}

/** Writes the row outright, key and verification together. Deciding whether an
 *  existing row may be overwritten is `lib/verification.ts`'s job — trust-on-
 *  first-use must not silently adopt a *changed* key, and that rule belongs
 *  next to the state machine that depends on it, not in the storage layer. */
export async function putContact(row: CachedContact): Promise<void> {
  if (!native()) {
    contactStore()?.set(row.peer_id, row);
    return;
  }
  await db?.run(
    `INSERT INTO contacts (peer_id, public_key, verified_at)
     VALUES (?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       public_key = excluded.public_key,
       verified_at = excluded.verified_at`,
    [row.peer_id, row.public_key, row.verified_at]
  );
}

/** Records that `messageId`'s decrypted bytes now live at `filePath`. */
export async function putPin(row: PinnedMedia): Promise<void> {
  if (!native()) {
    pinStore()?.set(row.message_id, row);
    return;
  }
  await db?.run(
    `INSERT INTO pins (message_id, file_path, pinned_at)
     VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       file_path = excluded.file_path,
       pinned_at = excluded.pinned_at`,
    [row.message_id, row.file_path, row.pinned_at]
  );
}

export async function cachedPin(messageId: string): Promise<PinnedMedia | null> {
  if (!native()) return pinStore()?.get(messageId) ?? null;
  const res = await db?.query('SELECT * FROM pins WHERE message_id = ?', [messageId]);
  return (res?.values?.[0] as PinnedMedia) ?? null;
}

/** Every pinned message id. The prune pass needs the whole set, and there are
 *  never enough pins for a per-row query to be worth the round trips. */
export async function pinnedIds(): Promise<Set<string>> {
  if (!native()) return new Set(pinStore()?.keys() ?? []);
  const res = await db?.query('SELECT message_id FROM pins');
  return new Set(((res?.values as { message_id: string }[]) ?? []).map((r) => r.message_id));
}

export async function removePin(messageId: string): Promise<void> {
  if (!native()) {
    pinStore()?.delete(messageId);
    return;
  }
  await db?.run('DELETE FROM pins WHERE message_id = ?', [messageId]);
}

/** Empties the open account's stores. Signing out must not take the other
 *  account's messages with it — and must not leave this account's trusted
 *  contacts behind for whoever signs in next on a shared device. */
export async function clearLocalDb(): Promise<void> {
  if (!native()) {
    memoryStore()?.clear();
    contactStore()?.clear();
    pinStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
  await db?.execute('DELETE FROM contacts');
  await db?.execute('DELETE FROM pins');
}
