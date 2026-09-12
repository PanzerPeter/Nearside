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
import { parseSealedRow, sealedOnly, type SealedRow } from './sealed-row';
import type { ConversationSummary, MediaType, Message } from './types';

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

/**
 * How far back this device has walked one conversation's history.
 *
 * The mirror holds what was decrypted, which until something goes looking is
 * only the pages somebody scrolled. Search, the "in this conversation" panel
 * and the transcript all read the mirror, so on a conversation older than the
 * screen they were answering from a fraction of it — and answering
 * confidently, which is the part that made it a bug rather than a limit.
 *
 * This row is the bookmark the walk resumes from. `complete` means the oldest
 * message was reached: there is nothing left to fetch, and new ones arrive
 * through the ordinary path already mirrored.
 */
export interface HistorySync {
  peer_id: string;
  /** The oldest row reached so far, as the cursor the next page asks for.
   *  Null before the first page. */
  oldest_at: string | null;
  oldest_id: string | null;
  /** 0 or 1 — SQLite has no boolean. */
  complete: number;
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
  /** Kept by the retention setting rather than pinned by hand. The two are the
   *  same file on disk and differ only in who asked for it — which is exactly
   *  what "clear automatically kept media" needs to tell apart, so that tidying
   *  up storage never throws away something somebody deliberately kept. */
  auto?: boolean;
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
  archived_at: string | null;
  /** Marked unread by hand. Stamped with the moment, so that a message
   *  arriving afterwards can clear it — a chat you deliberately left unread
   *  and then got a new message in is simply unread, and re-marking it would
   *  be the app arguing with the person. */
  unread_at: string | null;
  /**
   * How loudly this conversation should arrive: 'quiet' or 'urgent'.
   *
   * Null is the ordinary case and means "however the app's own notification
   * setting says" — the column holds the exceptions, like every other flag
   * here. Muting is deliberately not one of the values: it is a different
   * question (whether to show anything at all) with its own flag and its own
   * native store, and folding the two into one column would mean unmuting had
   * to guess which loudness to go back to.
   */
  alert_level: string | null;
}

/** The database file is named for the account, so the isolation is the
 *  filesystem's rather than a WHERE clause somebody can forget to write. */
const dbName = (userId: string) => `nearside-local-${userId}`;

/** Newest first, the order both drivers return rows in. */
const NEWEST_FIRST = (a: CachedMessage, b: CachedMessage) =>
  a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;

const SEARCH_LIMIT = 100;
/** Higher than one conversation's cap, because the results are spread across
 *  all of them: a hundred hits in the chat you are reading is a lot, and a
 *  hundred hits spread over thirty conversations is three each. */
const GLOBAL_SEARCH_LIMIT = 200;
const CONVERSATION_LIMIT = 1000;
/**
 * The cap the transcript export reads under.
 *
 * High enough not to be a cap in practice and still a number rather than "all
 * of it": the rows become one string the size of the whole conversation, and
 * an unbounded read is how a phone with a decade of messages on it runs out of
 * memory writing a file about them.
 */
export const EXPORT_LIMIT = 100_000;

/**
 * How many sealed rows one conversation keeps on this device.
 *
 * Two pages. One is what opening the chat paints; the second is what the first
 * flick back finds already there, which is the whole difference between a
 * thread that scrolls and a thread that stops to load. Beyond that the network
 * is doing the work anyway, and this store is not an archive — the plaintext
 * mirror is what search reads, and it keeps everything.
 */
export const SEALED_KEEP = 60;

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
  caption    TEXT,
  auto       INTEGER
);

CREATE TABLE IF NOT EXISTS chat_flags (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  pinned_at    TEXT,
  muted_at     TEXT,
  dismissed_at TEXT,
  archived_at  TEXT,
  unread_at    TEXT,
  alert_level  TEXT
);

CREATE TABLE IF NOT EXISTS messages_sealed (
  id         TEXT PRIMARY KEY,
  peer_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  row        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_sealed_peer_time
  ON messages_sealed (peer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_cache (
  peer_id   TEXT PRIMARY KEY,
  position  INTEGER NOT NULL,
  row       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_sync (
  peer_id    TEXT PRIMARY KEY,
  oldest_at  TEXT,
  oldest_id  TEXT,
  complete   INTEGER NOT NULL DEFAULT 0
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
const sealedMemory = new Map<string, Map<string, SealedEntry>>();
const listMemory = new Map<string, Map<string, ConversationSummary>>();
const historyMemory = new Map<string, Map<string, HistorySync>>();

/** A sealed row plus the two columns the store indexes and prunes on, so
 *  neither has to be parsed back out of the JSON to answer a query. */
interface SealedEntry {
  peer_id: string;
  created_at: string;
  expires_at: string | null;
  row: SealedRow;
}

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

function sealedStore(): Map<string, SealedEntry> | null {
  return scoped(sealedMemory);
}

function listStore(): Map<string, ConversationSummary> | null {
  return scoped(listMemory);
}

function historyStore(): Map<string, HistorySync> | null {
  return scoped(historyMemory);
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
      // Archive, and the deliberate "leave this unread" mark. Same reason as
      // the pins columns above: a store created before these existed has the
      // table without them.
      'chat_flags ADD COLUMN archived_at TEXT',
      'chat_flags ADD COLUMN unread_at TEXT',
      // How loudly one conversation arrives. Same reason as the columns above:
      // a store created before this existed has the table without it.
      'chat_flags ADD COLUMN alert_level TEXT',
      // 0 or 1. See `PinnedMedia.auto`.
      'pins ADD COLUMN auto INTEGER',
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
 * The same search, across every conversation this device has decrypted.
 *
 * One query rather than a loop over the conversations, which is the whole
 * reason this exists: the mirror already holds every chat in one table, and
 * asking it per conversation would be N round trips to answer a question the
 * store can answer in one.
 *
 * Results carry their `peer_id`, and naming it is the caller's job — a room id
 * and a friend's user id are both just ids here, and this file has no idea
 * which conversations the account is still in.
 */
export async function searchEverywhere(query: string): Promise<CachedMessage[]> {
  const needle = query.trim();
  if (!needle) return [];

  if (!native()) {
    const lowered = needle.toLowerCase();
    return [...(memoryStore()?.values() ?? [])]
      .filter((r) => r.text.toLowerCase().includes(lowered))
      .sort(NEWEST_FIRST)
      .slice(0, GLOBAL_SEARCH_LIMIT);
  }
  // ESCAPE for the same reason `searchCached` needs it: without it a search for
  // "50% off" matches "50X off".
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const res = await db?.query(
    `SELECT * FROM messages_cache
     WHERE text LIKE ? ESCAPE '\\'
     ORDER BY created_at DESC LIMIT ${GLOBAL_SEARCH_LIMIT}`,
    [`%${escaped}%`]
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

// ---- The sealed page --------------------------------------------------------
//
// `messages_cache` above holds decrypted *text*, which is what search and the
// sidebar preview read. It cannot paint a thread: it has no attachment, no
// reply pointer, no edit or delete stamp, and deliberately no file key.
//
// This store holds the rows as the server sent them — still sealed — so a
// conversation opened with no network goes through exactly the same `open()`
// the network path does and comes out the same shape. Nothing here is a
// second rendering path that can drift from the first.

/**
 * Write a page of server rows for one conversation, newest kept.
 *
 * Every row goes through `sealedOnly`: by the time the thread has a row it is
 * carrying an opened body and an opened attachment key, and neither belongs on
 * disk. See `lib/sealed-row.ts`.
 */
export async function putSealedRows(peerId: string, rows: readonly Message[]): Promise<void> {
  if (rows.length === 0) return;

  if (!native()) {
    const store = sealedStore();
    if (!store) return;
    for (const row of rows) {
      store.set(row.id, {
        peer_id: peerId,
        created_at: row.created_at,
        expires_at: row.expires_at,
        row: sealedOnly(row),
      });
    }
    trimSealedMemory(store, peerId);
    return;
  }

  for (const row of rows) {
    await db?.run(
      `INSERT INTO messages_sealed (id, peer_id, created_at, expires_at, row)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         peer_id    = excluded.peer_id,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         row        = excluded.row`,
      [row.id, peerId, row.created_at, row.expires_at, JSON.stringify(sealedOnly(row))]
    );
  }

  // Bounded per conversation rather than globally: a global cap would let one
  // busy chat evict every other conversation's opening page, which is the one
  // thing this store exists to guarantee.
  await db?.run(
    `DELETE FROM messages_sealed
      WHERE peer_id = ?
        AND id NOT IN (
          SELECT id FROM messages_sealed WHERE peer_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
        )`,
    [peerId, peerId, SEALED_KEEP]
  );
}

function trimSealedMemory(store: Map<string, SealedEntry>, peerId: string): void {
  const mine = [...store]
    .filter(([, entry]) => entry.peer_id === peerId)
    .sort(([aId, a], [bId, b]) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : bId.localeCompare(aId)
    );
  for (const [id] of mine.slice(SEALED_KEEP)) store.delete(id);
}

/** The newest cached rows for a conversation, newest first — the same order
 *  and shape `fetchLatestPage` returns. */
export async function cachedSealedRows(peerId: string, limit = SEALED_KEEP): Promise<SealedRow[]> {
  if (!native()) {
    return [...(sealedStore()?.values() ?? [])]
      .filter((e) => e.peer_id === peerId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, limit)
      .map((e) => e.row);
  }
  const res = await db?.query(
    `SELECT row FROM messages_sealed WHERE peer_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [peerId, limit]
  );
  const rows = (res?.values as { row: string }[]) ?? [];
  // A row that will not parse is dropped rather than rendered — the network
  // refills the page, and half a message is not a message.
  return rows.map((r) => parseSealedRow(r.row)).filter((r): r is SealedRow => r !== null);
}

/**
 * The newest cached message per conversation, in one read.
 *
 * What the prefetch compares against `conversation_list`'s `last_at` to decide
 * a conversation is already warm. One grouped query rather than a query per
 * conversation: the caller is deciding about the whole sidebar, and asking
 * forty times to skip thirty-eight of them is the cost the decision exists to
 * avoid.
 */
export async function sealedNewestByPeer(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!native()) {
    for (const entry of sealedStore()?.values() ?? []) {
      const held = out.get(entry.peer_id);
      if (!held || entry.created_at > held) out.set(entry.peer_id, entry.created_at);
    }
    return out;
  }
  const res = await db?.query(
    'SELECT peer_id, MAX(created_at) AS newest FROM messages_sealed GROUP BY peer_id'
  );
  for (const row of (res?.values as { peer_id: string; newest: string }[]) ?? []) {
    if (row.peer_id && row.newest) out.set(row.peer_id, row.newest);
  }
  return out;
}

/** Drop one row: a delete, or a message whose expiry has passed. */
// ---- The conversation list --------------------------------------------------

/**
 * Remember the sidebar exactly as `conversation_list()` answered it.
 *
 * The list is one RPC, and until it lands there is nothing on screen — no
 * names, no ordering, not even the self-chat the RPC always returns. On a slow
 * link that is a blank app for as long as the round trip takes, and with no
 * link at all it is a blank app until there is one, over a mirror that already
 * holds the conversations.
 *
 * `position` is stored because the ordering is the server's answer, not
 * something this device can recompute: `sortConversations` needs the pinned
 * flags and timestamps the row carries, and a cache that came back in
 * insertion order would repaint the list in a different order than the one
 * that replaces it a second later.
 */
export async function putConversationList(rows: readonly ConversationSummary[]): Promise<void> {
  if (!native()) {
    const store = listStore();
    if (!store) return;
    store.clear();
    for (const row of rows) store.set(row.peer_id, row);
    return;
  }
  // Replaced wholesale: a conversation removed on another device must not
  // survive here as a row nothing will ever overwrite.
  await db?.execute('DELETE FROM conversation_cache');
  for (const [index, row] of rows.entries()) {
    await db?.run('INSERT INTO conversation_cache (peer_id, position, row) VALUES (?, ?, ?)', [
      row.peer_id,
      index,
      JSON.stringify(row),
    ]);
  }
}

/** The sidebar as this device last saw it, in the order it was last shown. */
export async function cachedConversationList(): Promise<ConversationSummary[]> {
  if (!native()) return [...(listStore()?.values() ?? [])];
  const res = await db?.query('SELECT row FROM conversation_cache ORDER BY position ASC');
  const rows = (res?.values as { row: string }[]) ?? [];
  const out: ConversationSummary[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.row) as ConversationSummary;
      if (parsed && typeof parsed.peer_id === 'string') out.push(parsed);
    } catch {
      // Same reasoning as the sealed page: an unreadable row is skipped, and
      // the RPC behind it repaints the list a moment later.
    }
  }
  return out;
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
    `INSERT INTO pins (message_id, file_path, pinned_at, media_path, media_type, caption, auto)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       file_path = excluded.file_path,
       pinned_at = excluded.pinned_at,
       media_path = excluded.media_path,
       media_type = excluded.media_type,
       caption = excluded.caption,
       -- A hand pin over an auto-kept file promotes it, and never the other
       -- way round: once somebody has deliberately kept something, a later
       -- automatic pass must not quietly relabel it as disposable.
       auto = CASE WHEN excluded.auto = 1 THEN pins.auto ELSE 0 END`,
    [
      row.message_id,
      row.file_path,
      row.pinned_at,
      row.media_path,
      row.media_type,
      row.caption,
      row.auto ? 1 : 0,
    ]
  );
}

/** Drop only what the retention setting kept, leaving hand-made pins alone. */
export async function autoKeptPins(): Promise<PinnedMedia[]> {
  if (!native()) return [...(pinStore()?.values() ?? [])].filter((row) => row.auto);
  const res = await db?.query('SELECT * FROM pins WHERE auto = 1');
  return ((res?.values as PinnedMedia[]) ?? []).map((row) => ({ ...row, auto: true }));
}

export async function cachedPin(messageId: string): Promise<PinnedMedia | null> {
  if (!native()) return pinStore()?.get(messageId) ?? null;
  const res = await db?.query('SELECT * FROM pins WHERE message_id = ?', [messageId]);
  const row = res?.values?.[0] as (PinnedMedia & { auto?: number }) | undefined;
  // SQLite has no boolean; the column is 0/1 and every reader wants a boolean.
  return row ? { ...row, auto: !!row.auto } : null;
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

/** A row nobody has an opinion in any more. Kept as one predicate so the
 *  in-memory path and the SQL DELETE cannot disagree about what "empty" means
 *  — a new flag added to one and not the other would silently orphan rows. */
function isEmptyFlagRow(row: ChatFlagsRow): boolean {
  return (
    !row.pinned_at &&
    !row.muted_at &&
    !row.dismissed_at &&
    !row.archived_at &&
    !row.unread_at &&
    !row.alert_level
  );
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
  flag: 'pinned_at' | 'muted_at' | 'dismissed_at' | 'archived_at' | 'unread_at' | 'alert_level',
  /** The moment, for the stamped flags; the level, for `alert_level`. Null
   *  clears either. */
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
      archived_at: null,
      unread_at: null,
      alert_level: null,
    };
    const next = { ...row, kind, [flag]: at } as ChatFlagsRow;
    if (isEmptyFlagRow(next)) store.delete(id);
    else store.set(id, next);
    return;
  }
  await db?.run(
    `INSERT INTO chat_flags (id, kind, ${flag}) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, ${flag} = excluded.${flag}`,
    [id, kind, at]
  );
  await db?.run(
    `DELETE FROM chat_flags WHERE id = ?
       AND pinned_at IS NULL AND muted_at IS NULL AND dismissed_at IS NULL
       AND archived_at IS NULL AND unread_at IS NULL AND alert_level IS NULL`,
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

/** How far the walk through one conversation's history got, or null if it has
 *  never run here. */
export async function historySync(peerId: string): Promise<HistorySync | null> {
  if (!native()) return historyStore()?.get(peerId) ?? null;
  const res = await db?.query('SELECT * FROM history_sync WHERE peer_id = ?', [peerId]);
  return ((res?.values as HistorySync[]) ?? [])[0] ?? null;
}

/** Record the bookmark after a page. Written per page rather than at the end,
 *  because the walk is interrupted by the ordinary things — the panel closing,
 *  the app being put away — and starting over from the newest message each
 *  time is how a long conversation never finishes. */
export async function rememberHistorySync(state: HistorySync): Promise<void> {
  if (!native()) {
    historyStore()?.set(state.peer_id, state);
    return;
  }
  await db?.run(
    `INSERT INTO history_sync (peer_id, oldest_at, oldest_id, complete)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       oldest_at = excluded.oldest_at,
       oldest_id = excluded.oldest_id,
       complete  = excluded.complete`,
    [state.peer_id, state.oldest_at, state.oldest_id, state.complete]
  );
}

/** Drop one conversation's mirrored plaintext. Used by remove-contact, which
 *  must not leave the messages of somebody you just removed in search. */
export async function clearConversation(peerId: string): Promise<void> {
  if (!native()) {
    const store = memoryStore();
    if (!store) return;
    for (const [id, row] of store) if (row.peer_id === peerId) store.delete(id);
    const sealed = sealedStore();
    if (sealed) for (const [id, e] of sealed) if (e.peer_id === peerId) sealed.delete(id);
    listStore()?.delete(peerId);
    historyStore()?.delete(peerId);
    return;
  }
  await db?.run('DELETE FROM messages_cache WHERE peer_id = ?', [peerId]);
  // The bookmark describes plaintext that is now gone. Left behind, it would
  // tell the next walk there is nothing to fetch for a conversation this
  // device no longer holds a word of.
  await db?.run('DELETE FROM history_sync WHERE peer_id = ?', [peerId]);
  await db?.run('DELETE FROM messages_sealed WHERE peer_id = ?', [peerId]);
  await db?.run('DELETE FROM conversation_cache WHERE peer_id = ?', [peerId]);
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
    sealedStore()?.clear();
    historyStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
  // Every bookmark, too. Each one says "this conversation is already mirrored
  // back to here", which stops being true the moment the mirror is emptied —
  // and a stale "complete" is a search that quietly never refills.
  await db?.execute('DELETE FROM history_sync');
  // The sealed page goes with it. It is the same messages in their unopened
  // form, and a "clear the offline copy" that left the thread painting from
  // disk would be the button not doing what it says. The conversation list
  // stays: it is names and timestamps, not bodies, and losing it would empty
  // the sidebar of somebody who only asked to free space.
  await db?.execute('DELETE FROM messages_sealed');
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
    sealedStore()?.clear();
    listStore()?.clear();
    historyStore()?.clear();
    return;
  }
  await db?.execute('DELETE FROM messages_cache');
  await db?.execute('DELETE FROM contacts');
  await db?.execute('DELETE FROM pins');
  await db?.execute('DELETE FROM chat_flags');
  await db?.execute('DELETE FROM messages_sealed');
  await db?.execute('DELETE FROM conversation_cache');
  await db?.execute('DELETE FROM history_sync');
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
    const sealed = sealedStore();
    if (sealed) for (const [id, e] of sealed) if (hasExpired(e.expires_at, nowMs)) sealed.delete(id);
    return removed;
  }

  const at = new Date(nowMs).toISOString();
  const found = await db?.query(
    'SELECT id FROM messages_cache WHERE expires_at IS NOT NULL AND expires_at <= ?',
    [at]
  );
  const ids = (found?.values ?? []).map((row) => (row as { id: string }).id);
  // The sealed page is swept whether or not the mirror had anything to remove:
  // a row can reach this store and expire before it was ever opened, and a
  // disappearing message the thread paints from disk after the server deleted
  // it is the one failure this sweep exists to prevent.
  await db?.run('DELETE FROM messages_sealed WHERE expires_at IS NOT NULL AND expires_at <= ?', [
    at,
  ]);
  if (ids.length === 0) return [];
  await db?.run('DELETE FROM messages_cache WHERE expires_at IS NOT NULL AND expires_at <= ?', [
    at,
  ]);
  return ids;
}
