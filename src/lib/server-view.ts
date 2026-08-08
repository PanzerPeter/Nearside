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

export interface TableSpec {
  table: string;
  /** How to name it to someone who has never read a schema. */
  label: string;
  /** Columns the server can read in plaintext. Being honest about these is
   *  the point of the screen; hiding them would make it marketing. */
  readable: string[];
  /** Columns that are ciphertext to anyone holding a database credential. */
  opaque: string[];
  note: string;
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
    label: 'Your profile',
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
    note: 'Your display name, your avatar, and the public half of your key. The private half is on this phone and has never been sent anywhere.',
  },
  {
    table: 'friendships',
    label: 'Who you are connected to',
    readable: ['id', 'requester_id', 'addressee_id', 'status', 'created_at'],
    opaque: [],
    note: 'Who you are connected to, and when you connected. This is metadata the server genuinely can see, and there is no way to encrypt it while still routing a message.',
  },
  {
    table: 'messages',
    label: 'Your messages',
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
    ],
    opaque: ['ciphertext', 'nonce', 'media_key_ciphertext', 'media_key_nonce'],
    note: 'The server stores who sent what to whom and when, the size of each attachment, and how long each voice note runs. It cannot read a single word of any message, and it cannot open a single attachment.',
  },
  {
    table: 'message_reactions',
    label: 'Reactions',
    readable: ['id', 'message_id', 'user_id', 'emoji', 'created_at'],
    opaque: [],
    note: 'Reactions are not encrypted. A single emoji carries too little to seal usefully, and the server would still see who reacted to what and when.',
  },
  {
    table: 'message_receipts',
    label: 'Delivered and read marks',
    readable: ['user_id', 'peer_id', 'delivered_at', 'read_at', 'updated_at'],
    opaque: [],
    note: 'The timestamps behind the ticks. Timing information, by definition.',
  },
  {
    table: 'friend_nicknames',
    label: 'Private nicknames',
    readable: ['owner_id', 'peer_id', 'nickname', 'updated_at'],
    opaque: [],
    note: 'The names you gave your contacts. Private from them, since they are never told, but not private from the server, which stores them as ordinary text.',
  },
  {
    table: 'chat_backgrounds',
    label: 'Chat backgrounds',
    readable: ['owner_id', 'peer_id', 'media_path', 'updated_at'],
    opaque: [],
    note: 'Which background image you chose for which conversation.',
  },
  {
    table: 'rooms',
    label: 'Group rooms',
    readable: ['id', 'title', 'created_by', 'created_at', 'ttl_seconds', 'ttl_set_by'],
    opaque: [],
    note: 'A room title is stored as text so the server can list your rooms. Do not put anything in a title you would not put on an envelope. The last two columns are the room\u2019s disappearing-message timer and who set it.',
  },
  {
    table: 'room_participants',
    label: 'Room membership',
    readable: ['room_id', 'user_id', 'colour_index', 'joined_at'],
    opaque: [],
    note: 'Who is in which room, and since when.',
  },
  {
    table: 'room_keys',
    label: 'Room keys',
    readable: ['room_id', 'user_id', 'sealed_by'],
    opaque: ['key_ciphertext', 'key_nonce'],
    note: 'The room key, sealed once to each member. The server hands out a key it cannot open.',
  },
  {
    table: 'room_messages',
    label: 'Room messages',
    readable: ['id', 'room_id', 'sender_id', 'created_at', 'expires_at'],
    opaque: ['ciphertext', 'nonce', 'signature'],
    note: 'Same as your one-to-one conversations: timing and authorship, never content. The signature proves who wrote it without revealing what.',
  },
  {
    table: 'conversation_timers',
    label: 'Disappearing-message timers',
    readable: ['user_a', 'user_b', 'ttl_seconds', 'set_by', 'updated_at'],
    opaque: [],
    note: 'How long messages in a conversation last before the server deletes them. Two user ids, a number of seconds, and who set it last. No message content \u2014 the server has none to hold.',
  },
  {
    table: 'connect_tokens',
    label: 'Connect codes',
    readable: ['code', 'user_id', 'expires_at', 'used_at', 'used_by'],
    opaque: [],
    note: 'Short-lived codes for adding a contact. They expire after ten minutes and can be redeemed once. Nothing here is readable by any account, including yours.',
  },
  {
    table: 'message_pushes',
    label: 'Notification log',
    readable: ['message_id', 'sent_at'],
    opaque: [],
    note: 'One row per notification sent, so a message is never notified twice. A notification says who a message is from and nothing about what it says, because there is nothing here for the server to say.',
    infrastructure: true,
  },
  {
    table: 'push_config',
    label: 'Server configuration',
    readable: ['id', 'function_url', 'updated_at'],
    opaque: ['trigger_secret'],
    note: 'Server plumbing for notifications. It holds nothing about you.',
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
    })
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
    note:
      'Encrypted columns are exported as the ciphertext the server holds. ' +
      'They are unreadable without the key on your device, which is not in this file.',
  };

  for (const spec of TABLE_REPORTS) {
    if (spec.infrastructure) continue;
    const { data, error } = await supabase.from(spec.table).select('*');
    payload[spec.table] = error ? { error: error.message } : data;
  }

  return JSON.stringify(payload, null, 2);
}
