// What may be written to the on-device copy of a `messages` row.
//
// The thread cache exists so a conversation paints without the network, and the
// obvious way to build one — keep the rows the thread is already holding — is
// the wrong one. By the time a row reaches the thread it has been through
// `openRows`, which hangs the opened body and the *opened attachment key* off
// it as client-only fields. Storing that object would put a plaintext file key
// on disk beside the ciphertext it unlocks, which is the one thing the seal
// boundary exists to prevent (`lib/sealed-body.ts`).
//
// So the cache is fed through here, and what it holds is exactly what the
// server holds: still sealed, opened again on the way back out by the same
// `open()` the network path uses. The mirror in `localdb.ts` holds decrypted
// *text* — spec §7 discloses that — but a key is not text, and nothing has ever
// needed one at rest.

import type { Message } from './types';

/** The columns `messages` actually has. Anything not named here is client-only
 *  and must not survive the write — see the module comment. */
const COLUMNS = [
  'id',
  'user_id',
  'receiver_id',
  'ciphertext',
  'nonce',
  'media_path',
  'media_type',
  'media_thumb_path',
  'media_key_ciphertext',
  'media_key_nonce',
  'media_duration_ms',
  'reply_to_id',
  'forwarded',
  'sealed_prompt',
  'edited_at',
  'deleted_at',
  'expires_at',
  'created_at',
] as const;

/** A row as the server sent it: every real column, no opened body, no opened
 *  file key. */
export type SealedRow = Pick<Message, (typeof COLUMNS)[number]>;

/**
 * Strip a message down to its server columns.
 *
 * Allow-list rather than a delete-list: a new client-only field added to
 * `Message` later would be carried into the cache by a delete-list and nobody
 * would notice, and the field most likely to be added is another opened
 * secret.
 */
export function sealedOnly(row: Message): SealedRow {
  const out = {} as Record<string, unknown>;
  for (const column of COLUMNS) out[column] = row[column];
  return out as SealedRow;
}

/**
 * Read one back, refusing anything that is not a message row.
 *
 * The cache is JSON on disk, so a truncated write or a store left behind by an
 * older build can hand back an object with no id. Dropping it is right: the
 * network path refills the page, and a half row rendered as a message is a
 * bubble that cannot be replied to, deleted or opened.
 */
export function parseSealedRow(text: string): SealedRow | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.created_at !== 'string') return null;
  if (typeof row.user_id !== 'string' || typeof row.receiver_id !== 'string') return null;
  return row as unknown as SealedRow;
}
