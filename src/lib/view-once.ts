// View-once attachments (0058).
//
// The server's half is `consume_view_once()`: it clears the row's sealed file
// key and deletes the object, and nothing else may say a message was opened.
// This module is the client's half — what the bubble shows, and the one
// opening — and it is deliberately narrow about what it claims. A modified app
// can keep the bytes it was handed; what an honest one does is show the
// picture once, from memory, under FLAG_SECURE, and then make the server
// forget it.

import { supabase } from './supabase';
import { openFile } from './media-crypto';
import { mimeForPath } from './media';
import type { Message } from './types';

export type ViewOnceState =
  /** Yours, not opened yet. You cannot open it either — it was sent to them. */
  | 'sent'
  /** Yours, and they have opened it. */
  | 'seen'
  /** Theirs, waiting for its one opening. */
  | 'ready'
  /** Theirs, already opened, or arrived with no key this device can use. */
  | 'opened';

export function viewOnceState(
  msg: Pick<Message, 'user_id' | 'viewed_at' | 'media_key'>,
  me: string
): ViewOnceState {
  if (msg.user_id === me) return msg.viewed_at ? 'seen' : 'sent';
  return msg.viewed_at || !msg.media_key ? 'opened' : 'ready';
}

/**
 * Fetch, open and spend the one view.
 *
 * Consumed as soon as the picture is in memory rather than when the viewer
 * closes: a close that never comes — the app killed, the phone dropped — would
 * otherwise leave it openable again, which is the one thing it must not be.
 * The bytes are never written anywhere: not the pin store, not the signed-URL
 * cache, not the local mirror. The object URL returned is the only copy, and
 * the caller revokes it.
 */
export async function openViewOnce(
  msg: Pick<Message, 'id' | 'media_path' | 'media_type' | 'media_key'>
): Promise<string> {
  if (!msg.media_path || !msg.media_key) throw new Error('view-once: nothing to open');
  const { data, error } = await supabase.storage
    .from('chat-media')
    .createSignedUrl(msg.media_path, 60);
  if (error || !data) throw error ?? new Error('view-once: no signed url');
  const response = await fetch(data.signedUrl);
  if (!response.ok) throw new Error(`view-once: ${response.status}`);
  const opened = await openFile(new Uint8Array(await response.arrayBuffer()), msg.media_key);
  const url = URL.createObjectURL(
    new Blob([opened as BlobPart], { type: mimeForPath(msg.media_path, msg.media_type) })
  );
  const { error: consumeError } = await supabase.rpc('consume_view_once', { target: msg.id });
  // Shown anyway: the bytes are already here, and refusing to show what has
  // been fetched protects nothing. The next open finds the row unspent and
  // tries the consume again, so it is logged rather than lost.
  if (consumeError) console.error('consume_view_once failed', consumeError);
  return url;
}
