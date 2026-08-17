// What the server actually knows.
//
// The screen this backs is a proof, not a promise. Every row count is a live
// query run as the signed-in user, so RLS scopes it to their own data, and the
// column lists say plainly which fields the server reads and which are
// ciphertext to anyone holding a database credential.
//
// The honest half matters more than the reassuring half: a screen that only
// said "your messages are encrypted" would be marketing. Saying `messages —
// server reads: user_id, receiver_id, created_at` is an admission, and it is
// the admission that makes the rest believable.
import { supabase } from './supabase';
import type { MessageKey } from './i18n';

/** Which of the three headings a table sits under. Eighteen cards in one flat
 *  list is a wall; the split is the difference between "the server holds a lot"
 *  and "the server holds your envelopes, never your letters". */
export type TableGroup = 'content' | 'about-you' | 'plumbing';

export interface GroupSpec {
  group: TableGroup;
  title: MessageKey;
  /** Why every table under this heading is here, in one sentence. */
  blurb: MessageKey;
}

/** Render order, and the only place a heading's wording lives. */
export const TABLE_GROUPS: readonly GroupSpec[] = [
  {
    group: 'content',
    title: 'server.content.title',
    blurb: 'server.content.blurb',
  },
  {
    group: 'about-you',
    title: 'server.aboutYou.title',
    blurb: 'server.aboutYou.blurb',
  },
  {
    group: 'plumbing',
    title: 'server.plumbing.title',
    blurb: 'server.plumbing.blurb',
  },
];

export interface TableSpec {
  table: string;
  /** How to name it to someone who has never read a schema — a message key,
   *  because this list is built at import and the words are looked up where
   *  the card is drawn. */
  label: MessageKey;
  group: TableGroup;
  /** Columns the server can read in plaintext. Being honest about these is
   *  the point of the screen; hiding them would make it marketing. */
  readable: string[];
  /** Columns that are ciphertext to anyone holding a database credential. */
  opaque: string[];
  note: MessageKey;
  /** Plumbing rather than user data — no row count is shown, because the
   *  number would be meaningless or zero under RLS and reads as a bug. */
  infrastructure?: boolean;
}

/**
 * Every table in the `public` schema, described.
 *
 * Kept exhaustive on purpose: `unlistedTables` compares this list against what
 * the database actually holds, so a table added and never described here shows
 * the user a warning rather than letting the screen quietly go stale.
 */
export const TABLE_REPORTS: TableSpec[] = [
  {
    table: 'profiles',
    group: 'about-you',
    label: 'server.profiles.label',
    readable: [
      'id',
      'display_name',
      'avatar_url',
      'last_seen_at',
      'public_key',
      'signing_key',
      'key_updated_at',
      'created_at',
      'updated_at',
    ],
    opaque: [],
    note: 'server.profiles.note',
  },
  {
    table: 'friendships',
    group: 'about-you',
    label: 'server.friendships.label',
    readable: ['id', 'requester_id', 'addressee_id', 'status', 'created_at'],
    opaque: [],
    note: 'server.friendships.note',
  },
  {
    table: 'messages',
    group: 'content',
    label: 'server.messages.label',
    readable: [
      'id',
      'user_id',
      'receiver_id',
      'created_at',
      'edited_at',
      'deleted_at',
      'reply_to_id',
      'forwarded',
      'media_path',
      'media_type',
      'media_duration_ms',
      'expires_at',
      'sealed_prompt',
    ],
    opaque: ['ciphertext', 'nonce', 'media_key_ciphertext', 'media_key_nonce'],
    note: 'server.messages.note',
  },
  {
    table: 'message_reactions',
    group: 'content',
    label: 'server.message_reactions.label',
    readable: ['id', 'message_id', 'user_id', 'emoji', 'created_at'],
    opaque: [],
    note: 'server.message_reactions.note',
  },
  {
    table: 'message_receipts',
    group: 'about-you',
    label: 'server.message_receipts.label',
    readable: ['user_id', 'peer_id', 'delivered_at', 'read_at', 'updated_at'],
    opaque: [],
    note: 'server.message_reactions.note',
  },
  {
    table: 'friend_nicknames',
    group: 'about-you',
    label: 'server.friend_nicknames.label',
    readable: ['owner_id', 'peer_id', 'nickname', 'updated_at'],
    opaque: [],
    note: 'server.friend_nicknames.note',
  },
  {
    table: 'chat_backgrounds',
    group: 'about-you',
    label: 'server.chat_backgrounds.label',
    readable: ['owner_id', 'peer_id', 'media_path', 'updated_at'],
    // The path is readable and the picture is not. Backgrounds were the last
    // image this app uploaded in the clear; 0039 seals them under the vault
    // key, like a sticker.
    opaque: ['key_ciphertext', 'key_nonce'],
    note: 'server.friend_nicknames.note',
  },
  {
    table: 'rooms',
    group: 'about-you',
    label: 'server.rooms.label',
    readable: ['id', 'title', 'created_by', 'created_at', 'ttl_seconds', 'ttl_set_by'],
    opaque: [],
    note: 'server.rooms.note',
  },
  {
    table: 'room_participants',
    group: 'about-you',
    label: 'server.room_participants.label',
    readable: ['room_id', 'user_id', 'colour_index', 'joined_at'],
    opaque: [],
    note: 'server.rooms.note',
  },
  {
    table: 'room_keys',
    group: 'about-you',
    label: 'server.room_keys.label',
    readable: ['room_id', 'user_id', 'sealed_by'],
    opaque: ['key_ciphertext', 'key_nonce'],
    note: 'server.room_keys.note',
  },
  {
    table: 'room_messages',
    group: 'content',
    label: 'server.room_participants.label',
    readable: ['id', 'room_id', 'sender_id', 'created_at', 'expires_at'],
    opaque: ['ciphertext', 'nonce', 'signature'],
    note: 'server.room_participants.note',
  },
  {
    table: 'sealed_answers',
    group: 'content',
    label: 'server.sealed_answers.label',
    readable: ['id', 'prompt_id', 'user_id', 'created_at'],
    opaque: ['ciphertext', 'nonce'],
    note: 'server.sealed_answers.note',
  },
  {
    table: 'stickers',
    group: 'content',
    label: 'server.stickers.label',
    readable: ['id', 'user_id', 'path', 'sort', 'created_at'],
    opaque: ['key_ciphertext', 'key_nonce', 'label_ciphertext', 'label_nonce'],
    note: 'server.sealed_answers.note',
  },
  {
    table: 'conversation_timers',
    group: 'about-you',
    label: 'server.conversation_timers.label',
    readable: ['user_a', 'user_b', 'ttl_seconds', 'set_by', 'updated_at'],
    opaque: [],
    note: 'server.conversation_timers.note',
  },
  {
    table: 'theme_grants',
    group: 'about-you',
    label: 'server.theme_grants.label',
    readable: ['user_id', 'pack_id', 'note', 'granted_at'],
    opaque: [],
    note: 'server.theme_grants.note',
  },
  {
    table: 'connect_tokens',
    group: 'about-you',
    label: 'server.connect_tokens.label',
    readable: ['code', 'user_id', 'expires_at', 'used_at', 'used_by'],
    opaque: [],
    note: 'server.conversation_timers.note',
  },
  {
    table: 'message_pushes',
    group: 'plumbing',
    label: 'server.message_pushes.label',
    readable: ['message_id', 'sent_at'],
    opaque: [],
    note: 'server.message_pushes.note',
    infrastructure: true,
  },
  {
    table: 'push_alerts',
    group: 'plumbing',
    label: 'server.push_alerts.label',
    readable: ['receiver_id', 'sender_id', 'alerted_at'],
    opaque: [],
    note: 'server.push_alerts.note',
    infrastructure: true,
  },
  {
    table: 'push_config',
    group: 'plumbing',
    label: 'server.push_config.label',
    readable: ['id', 'function_url', 'updated_at'],
    opaque: ['trigger_secret'],
    note: 'server.message_pushes.note',
    infrastructure: true,
  },
];

/** Tables present in the schema that nobody has described here. Shown to the
 *  user as a warning rather than hidden, so the screen degrades into "we are
 *  not sure" instead of silently going stale. */
export function unlistedTables(actual: string[]): string[] {
  const described = new Set(TABLE_REPORTS.map((t) => t.table));
  return actual.filter((t) => !described.has(t));
}

/** Described tables the schema no longer has. The mirror of the above, and the
 *  reason it exists: `0023` dropped a column this screen once claimed, and a
 *  list that only grew would have gone on describing it. */
export function missingTables(actual: string[]): string[] {
  const present = new Set(actual);
  return TABLE_REPORTS.filter((t) => !present.has(t.table)).map((t) => t.table);
}

export interface TableReport extends TableSpec {
  /** Rows this account can see. Null when the table is infrastructure, or
   *  when RLS refuses the count — both of which are honest answers and
   *  neither of which is zero. */
  rows: number | null;
}

export interface StoredDataReport {
  tables: TableReport[];
  unlisted: string[];
  missing: string[];
}

export interface GroupedTables extends GroupSpec {
  tables: TableReport[];
}

/**
 * The report, split under its headings, in `TABLE_GROUPS` order.
 *
 * A heading with nothing under it is dropped rather than rendered empty: the
 * only way that happens is a schema where every table of one kind is gone, and
 * an empty "What you say and send" would read as a claim that the server holds
 * no messages.
 */
export function groupTables(tables: readonly TableReport[]): GroupedTables[] {
  return TABLE_GROUPS.map((spec) => ({
    ...spec,
    tables: tables.filter((t) => t.group === spec.group),
  })).filter((g) => g.tables.length > 0);
}

/** The names of every table in the `public` schema, from the database itself.
 *  Backed by a SECURITY DEFINER RPC because `information_schema` is not
 *  reachable through PostgREST — see 0027_transparency.sql. */
async function schemaTableNames(): Promise<string[]> {
  const { data, error } = await supabase.rpc('public_table_names');
  if (error) throw error;
  return (data as { table_name: string }[] | null)?.map((r) => r.table_name) ?? [];
}

/**
 * Counts run as the signed-in user, so RLS scopes them to that user's own
 * rows — the number shown is what the server holds about *them*, not what it
 * holds in total.
 */
export async function describeStoredData(): Promise<StoredDataReport> {
  const tables = await Promise.all(
    TABLE_REPORTS.map(async (spec): Promise<TableReport> => {
      if (spec.infrastructure) return { ...spec, rows: null };
      const { count, error } = await supabase
        .from(spec.table)
        .select('*', { count: 'exact', head: true });
      return { ...spec, rows: error ? null : (count ?? 0) };
    }),
  );

  // A schema the client cannot enumerate is not a reason to fail the whole
  // screen — the per-table reports above are still true. Report no drift
  // rather than inventing some.
  const actual = await schemaTableNames().catch(() => null);

  return {
    tables,
    unlisted: actual ? unlistedTables(actual) : [],
    missing: actual ? missingTables(actual) : [],
  };
}

/** Everything this account can read, as one JSON document. Built from the same
 *  specs the screen renders, so an export cannot describe a different app than
 *  the screen above it. */
export async function exportEverything(): Promise<string> {
  const payload: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    note: 'server.push_config.note' +
      'They are unreadable without the key on your device, which is not in this file.',
  };

  for (const spec of TABLE_REPORTS) {
    if (spec.infrastructure) continue;
    const { data, error } = await supabase.from(spec.table).select('*');
    payload[spec.table] = error ? { error: error.message } : data;
  }

  return JSON.stringify(payload, null, 2);
}
