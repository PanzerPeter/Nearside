// Decrypted message text, on the device only. This is what search and the
// conversation list read from once 0023 takes those capabilities away from
// Postgres. It holds plaintext at rest in app-private storage, which spec §7
// discloses rather than hides.
//
// One store per account, never one per device: two people sharing a phone must
// not find each other's decrypted messages in their own search results.
import { hasExpired } from './disappearing';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { isMobileNative } from './platform';
import type { MediaType } from './types';

export interface CachedMessage {
  id: string;
  peer_id: string;
  user_id: string;
  text: string;
  created_at: string;
  /** The server's stamp, mirrored so this device can drop the row on the same
   *  schedule. The server deleting its copy does nothing about the decrypted
   *  one here, which is the copy search reads from. */
  expires_at: string | null;
}

/** A pinned attachment: the plaintext bytes are on this device, at
 *  `file_path`, and the server copy may be pruned at any time. Local only —
 *  a pin is a promise this phone makes, not one the server keeps. */
export interface PinnedMedia {
  message_id: string;
  file_path: string;
  pinned_at: string;
  /** What the message row held when the pin was made. The sender's device
   *  nulls those columns when it trims the object (`trimOldMedia`), so without
   *  a copy here the bubble has nothing left to render the kept bytes from —
   *  see `lib/pin-restore.ts`. Null on pins written before this was recorded.
   *
   *  `caption` is plaintext, like everything else in this store: it is the
   *  body this device had already decrypted, and spec §7 discloses that the
   *  mirror holds decrypted text at rest. */
  media_path: string | null;
  media_type: MediaType | null;
  caption: string | null;
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

/**
 * This device's opinion about one conversation: where it sits in the list,
 * whether it makes a sound, and whether a request from that person is shown.
 *
 * Local by design. A server-held pin list would tell the server which
 * conversations matter most to you, and a server-held mute list would tell it
 * which people you are avoiding — both of them facts the product otherwise
 * never learns. The cost is that none of it follows you to a second device.
 */
export interface ChatFlagsRow {
  id: string;
  /** 'peer' or 'room'. Ids come from two different tables; nothing else keeps
   *  them from colliding. */
  kind: string;
  pinned_at: string | null;
  muted_at: string | null;
  dismissed_at: string | null;
}

/** The database file is named for the account, so the isolation is the
 *  filesystem's rather than a WHERE clause somebody can forget to write. */
const dbName = (userId: string) => `nearside-local-${userId}`;

/** Newest first, the order both drivers return rows in. */
const NEWEST_FIRST = (a: CachedMessage, b: CachedMessage) =>
  a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;

const SEARCH_LIMIT = 100;
const CONVERSATION_LIMIT = 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_cache (
  id         TEXT PRIMARY KEY,
  peer_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
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
  pinned_at  TEXT NOT NULL,
  media_path TEXT,
  media_type TEXT,
  caption    TEXT
);

CREATE TABLE IF NOT EXISTS chat_flags (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  pinned_at    TEXT,
  muted_at     TEXT,
  dismissed_at TEXT
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
const flagMemory = new Map<string, Map<string, ChatFlagsRow>>();

function native(): boolean {
  return isMobileNative();
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

function flagStore(): Map<string, ChatFlagsRow> | null {
  return scoped(flagMemory);
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
    // SQLite has no ADD COLUMN IF NOT EXISTS. A store created by an earlier
    // build already has the table, so CREATE TABLE IF NOT EXISTS skips the new
    // column and every write below fails on an unknown column instead.
    for (const column of [
      'messages_cache ADD COLUMN expires_at TEXT',
      // The three a pin needs to put a trimmed row back together. A store
      // created by an earlier build has the `pins` table without them, and
      // every write below would fail on an unknown column.
      'pins ADD COLUMN media_path TEXT',
      'pins ADD COLUMN media_type TEXT',
      'pins ADD COLUMN caption TEXT',
    ]) {
      try {
        await db.execute(`ALTER TABLE ${column}`);
      } catch {
        // Already there.
      }
    }
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
    `INSERT INTO messages_cache (id, peer_id, user_id, text, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET text = excluded.text, expires_at = excluded.expires_at`,
    [row.id, row.peer_id, row.user_id, row.text, row.created_at, row.expires_at]
  );
}

/**
 * Drop one message's decrypted copy.
 *
 * A deletion has to reach this store as well as the server's row. The mirror is
 * what search and the sidebar preview read from, so a body left here after the
 * message was deleted goes on being findable and goes on being previewed — the
 * one place in the app where "delete" would visibly not have deleted anything.
 */
export async function forgetCachedMessage(id: string): Promise<void> {
  if (!native()) {
    memoryStore()?.delete(id);
    return;
  }
  await db?.run('DELETE FROM messages_cache WHERE id = ?', [id]);
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

/**
 * The whole conversation as this device decrypted it, newest first.
 *
 * What `extract.ts` reads. Capped because the panel scans every row it is
 * given: a conversation years deep would spend that scan on messages whose
 * "friday" resolved to a Friday long gone.
 */
export async function cachedConversation(
  peerId: string,
  limit = CONVERSATION_LIMIT
): Promise<CachedMessage[]> {
  if (!native()) {
    return [...(memoryStore()?.values() ?? [])]
      .filter((r) => r.peer_id === peerId)
      .sort(NEWEST_FIRST)
      .slice(0, limit);
  }
  const res = await db?.query(
    'SELECT * FROM messages_cache WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?',
    [peerId, limit]
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
    `INSERT INTO pins (message_id, file_path, pinned_at, media_path, media_type, caption)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       file_path = excluded.file_path,
       pinned_at = excluded.pinned_at,
       media_path = excluded.media_path,
       media_type = excluded.media_type,
       caption = excluded.caption`,
    [row.message_id, row.file_path, row.pinned_at, row.media_path, row.media_type, row.caption]
  );
}

export async function cachedPin(messageId: string): Promise<PinnedMedia | null> {
  if (!native()) return pinStore()?.get(messageId) ?? null;
  const res = await db?.query('SELECT * FROM pins WHERE message_id = ?', [messageId]);
  return (res?.values?.[0] as PinnedMedia) ?? null;
}

/**
 * Every conversation this device has an opinion about.
 *
 * The whole table, not a per-row query: there is one row per pinned, muted or
 * dismissed conversation and the list needs all of them to sort itself. A
 * conversation with no row is the ordinary case and costs nothing.
 */
export async function allChatFlags(): Promise<Map<string, ChatFlagsRow>> {
  if (!native()) return new Map(flagStore() ?? []);
  const res = await db?.query('SELECT * FROM chat_flags');
  return new Map(((res?.values as ChatFlagsRow[]) ?? []).map((row) => [row.id, row]));
}

/**
 * Set one flag on one conversation, creating the row if this is the first.
 *
 * A row whose three flags are all null is deleted rather than kept: the table
 * is meant to hold the exceptions, and a store that accumulated a row per
 * conversation ever pinned would make `allChatFlags` grow without bound.
 */
export async function setChatFlag(
  id: string,
  kind: 'peer' | 'room',
  flag: 'pinned_at' | 'muted_at' | 'dismissed_at',
  at: string | null
): Promise<void> {
  if (!native()) {
    const store = flagStore();
    if (!store) return;
    const row: ChatFlagsRow = store.get(id) ?? {
      id,
      kind,
      pinned_at: null,
      muted_at: null,
      dismissed_at: null,
    };
    const next = { ...row, kind, [flag]: at } as ChatFlagsRow;
    if (!next.pinned_at && !next.muted_at && !next.dismissed_at) store.delete(id);
    else store.set(id, next);
    return;
  }
  await db?.run(
    `INSERT INTO chat_flags (id, kind, ${flag}) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, ${flag} = excluded.${flag}`,
    [id, kind, at]
  );
  await db?.run(
    'DELETE FROM chat_flags WHERE id = ? AND pinned_at IS NULL AND muted_at IS NULL AND dismissed_at IS NULL',
    [id]
  );
}

/** Forget everything this device thought about one conversation. Part of
 *  removing a contact: the pin, the silence and the dismissal all described a
 *  relationship that no longer exists. */
export async function forgetChatFlags(id: string): Promise<void> {
  if (!native()) {
    flagStore()?.delete(id);
    return;
  }
  await db?.run('DELETE FROM chat_flags WHERE id = ?', [id]);
}

/** Drop one conversation's mirrored plaintext. Used by remove-contact, which
 *  must not leave the messages of somebody you just removed in search. */
export async function clearConversation(peerId: string): Promise<void> {
  if (!native()) {
    const store = memoryStore();
    if (!store) return;
    for (const [id, row] of store) if (row.peer_id === peerId) store.delete(id);
    return;
  }
  await db?.run('DELETE FROM messages_cache WHERE peer_id = ?', [peerId]);
}

/** Every pinned message id. The prune pass needs the whole set, and there are
 *  never enough pins for a per-row query to be worth the round trips. */
export async function pinnedIds(): Promise<Set<string>> {
  if (!native()) return new Set(pinStore()?.keys() ?? []);
  const res = await db?.query('SELECT message_id FROM pins');
  return new Set(((res?.values as { message_id: string }[]) ?? []).map((r) => r.message_id));
}

/** Every pin, paths included. `pinnedIds` answers the prune pass; this answers
 *  the teardown that has to delete the files those paths name. */
export async function allPins(): Promise<PinnedMedia[]> {
  if (!native()) return [...(pinStore()?.values() ?? [])];
  const res = await db?.query('SELECT * FROM pins');
  return (res?.values as PinnedMedia[]) ?? [];
}

/** How much of this account's mirror exists, for the storage screen. */
export interface LocalDbStats {
  /** Decrypted message bodies held on this device. */
  messages: number;
  /** Conversations they belong to — the number that explains why search finds
   *  nothing in a chat this device has never opened. */
  conversations: number;
  pins: number;
}

/**
 * Counts, never bodies.
 *
 * Deliberately not a size in bytes: SQLite's file is the account's whole store
 * and Capacitor gives no honest way to ask how much of it is messages, so a
 * number here would be a guess presented as a measurement. A count of what is
 * mirrored is the fact the user can actually act on.
 */
export async function localDbStats(): Promise<LocalDbStats> {
  if (!native()) {
    const rows = [...(memoryStore()?.values() ?? [])];
    return {
      messages: rows.length,
      conversations: new Set(rows.map((r) => r.peer_id)).size,
      pins: pinStore()?.size ?? 0,
    };
  }
  const res = await db?.query(
    `SELECT COUNT(*) AS messages, COUNT(DISTINCT peer_id) AS conversations FROM messages_cache`
  );
  const pins = await db?.query('SELECT COUNT(*) AS pins FROM pins');
  const row = (res?.values?.[0] as { messages?: number; conversations?: number }) ?? {};
  return {
    messages: row.messages ?? 0,
    conversations: row.conversations ?? 0,
    pins: (pins?.values?.[0] as { pins?: number })?.pins ?? 0,
  };
}

export async function removePin(messageId: string): Promise<void> {
  if (!native()) {
    pinStore()?.delete(messageId);
    return;
  }
  await db?.run('DELETE FROM pins WHERE message_id = ?', [messageId]);
}

/**
 * Drop the decrypted message bodies and nothing else.
 *
 * What the storage screen's "clear" offers, and deliberately narrower than
 * `clearLocalDb`: that one also empties `contacts`, which is where a peer's key
 * was first seen and whether a human ever verified it. Freeing space must not
 * quietly reset trust-on-first-use and re-verify every contact — the one thing
 * in this store the user cannot rebuild by scrolling.
 */
export async function clearCachedMessages(): Promise<void> {
  if (!native()) {
    memoryStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
}

/** Empties the open account's stores. Signing out must not take the other
 *  account's messages with it — and must not leave this account's trusted
 *  contacts behind for whoever signs in next on a shared device. */
export async function clearLocalDb(): Promise<void> {
  if (!native()) {
    memoryStore()?.clear();
    contactStore()?.clear();
    pinStore()?.clear();
    flagStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
  await db?.execute('DELETE FROM contacts');
  await db?.execute('DELETE FROM pins');
  await db?.execute('DELETE FROM chat_flags');
}

/**
 * Empties a *different* account's store, then reopens the caller's.
 *
 * Needed because the account switcher can drop an account the device is not
 * currently signed into, and that account's mirror is decrypted message text
 * sitting in the sandbox. Leaving it there would make "remove from this device"
 * the one delete in the app that removes the way back in and keeps the contents.
 *
 * There is no second connection: every read and write in this file goes through
 * the one `db`, so the only way to reach another store is to become its owner
 * for the duration and hand ownership back. `restoreUserId` is passed rather
 * than remembered so a caller with nobody signed in can pass null and leave the
 * connection closed.
 */
export async function clearLocalDbFor(
  userId: string,
  restoreUserId: string | null
): Promise<void> {
  if (userId === restoreUserId) {
    await clearLocalDb();
    return;
  }
  await openLocalDb(userId);
  await clearLocalDb();
  if (restoreUserId) await openLocalDb(restoreUserId);
}

/**
 * Drop every mirrored row whose server-stamped expiry has passed.
 *
 * Returns the ids removed so a caller can drop the same messages from whatever
 * it is currently rendering — a row deleted from the mirror but left on screen
 * is a message the user watches not disappear.
 */
export async function purgeExpired(nowMs: number): Promise<string[]> {
  if (!native()) {
    const store = memoryStore();
    if (!store) return [];
    const removed: string[] = [];
    for (const [id, row] of store) {
      if (hasExpired(row.expires_at, nowMs)) {
        store.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  const at = new Date(nowMs).toISOString();
  const found = await db?.query(
    'SELECT id FROM messages_cache WHERE expires_at IS NOT NULL AND expires_at <= ?',
    [at]
  );
  const ids = (found?.values ?? []).map((row) => (row as { id: string }).id);
  if (ids.length === 0) return [];
  await db?.run('DELETE FROM messages_cache WHERE expires_at IS NOT NULL AND expires_at <= ?', [
    at,
  ]);
  return ids;
}
