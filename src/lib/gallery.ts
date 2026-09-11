// The pictures and videos of one conversation, in the order they were sent.
//
// The viewer used to open one attachment and dead-end: closing it and finding
// the next photo in the thread was the only way through a set of them, which is
// not how anybody looks at pictures. This turns the messages a thread is
// holding into the list the viewer steps along.
//
// Built from the rows the thread has already opened rather than from a query of
// its own. Those rows carry an opened file key, and the key is what makes an
// object readable — a second list assembled from somewhere else would be a list
// of things the viewer could name and not open. The practical limit is that the
// list is as long as the thread is loaded: scrolling further back lengthens it,
// which is the same rule the thread itself lives by.

import type { MediaType, VisualMediaType } from './types';

/** One entry in the viewer: everything it needs to decrypt and draw a file,
 *  with no reference back to the message list it came from. */
export interface GalleryItem {
  messageId: string;
  path: string;
  type: VisualMediaType;
  mediaKey: Uint8Array | null;
  caption: string | null;
  expiresAt: string | null;
  /** These columns were put back from this device's pin, so the server object
   *  is already gone — see `lib/pin-restore.ts`. */
  restored: boolean;
}

/**
 * What a row must look like to be worth showing full-size.
 *
 * Its own shape rather than a `Pick` of `Message`, because a group's rows are
 * not `Message`s: they carry a signature and a sender verdict, and several of
 * the columns a 1:1 row always has are optional on one. Everything optional
 * here is optional on exactly one of the two.
 */
export interface GalleryRow {
  id: string;
  media_path?: string | null;
  media_type?: MediaType | null;
  media_key?: Uint8Array | null;
  text?: string | null;
  expires_at?: string | null;
  deleted_at?: string | null;
  /** These columns were put back from this device's pin. */
  restored?: boolean;
}

function isVisual(type: MediaType | null | undefined): type is VisualMediaType {
  return type === 'image' || type === 'video';
}

/**
 * The conversation's images and videos, oldest first.
 *
 * Stickers and voice notes are deliberately not in it. A sticker is the message
 * rather than an attachment to one, and neither has a full-size view to step
 * into — putting them in the list would mean the arrow keys sometimes moved to
 * something with nothing to show.
 *
 * A deleted message is skipped: its columns may still be on the row this device
 * is holding, and the object behind them is gone.
 */
export function galleryItems(rows: readonly GalleryRow[]): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const row of rows) {
    if (row.deleted_at) continue;
    if (!row.media_path || !isVisual(row.media_type)) continue;
    items.push({
      messageId: row.id,
      path: row.media_path,
      type: row.media_type,
      mediaKey: row.media_key ?? null,
      caption: row.text ?? null,
      expiresAt: row.expires_at ?? null,
      restored: row.restored ?? false,
    });
  }
  return items;
}

/**
 * Where `messageId` sits in the list, or -1.
 *
 * The viewer is opened from a bubble and has to find its own starting point:
 * the same file can be in a conversation more than once — a photo forwarded
 * back, or sent twice — and two of those share a storage path but never a
 * message id.
 */
export function galleryIndexOf(items: readonly GalleryItem[], messageId: string): number {
  return items.findIndex((item) => item.messageId === messageId);
}

/**
 * The index `delta` steps away, clamped to the ends.
 *
 * Deliberately not a wrap-around. A gallery that loops gives no signal that you
 * have reached the oldest picture, and in a thread whose older pages are not
 * loaded yet "the oldest" is a moving claim — quietly jumping back to the
 * newest would look like the viewer had lost its place.
 */
export function stepGallery(items: readonly GalleryItem[], from: number, delta: number): number {
  if (items.length === 0) return -1;
  return Math.min(items.length - 1, Math.max(0, from + delta));
}
