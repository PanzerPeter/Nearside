// Putting a pinned attachment back into a row the server has since emptied.
//
// A pin is this device promising to keep a picture after the server copy goes
// (`lib/pins.ts`). Only half of that promise used to hold. The *sender's*
// device trims its own old attachments (`trimOldMedia` in `useMediaSend`) and
// relabels the row it trimmed: `media_path`, `media_type` and the file key are
// nulled and the body is replaced with "media removed". Their pins protect
// their rows — `selectStaleMedia` skips them — but nobody else's pin can, and
// a pin list is deliberately local, so the sender cannot know.
//
// The bytes were still on the recipient's phone. The bubble simply had nothing
// left to render them from: no path, no kind, and a caption overwritten by the
// placeholder. So the pin row carries what the message columns held at the
// moment it was made, and this puts them back for rendering.
//
// Deliberately *not* put back:
//   - the file key, which described an object that no longer exists. The
//     restored row reads from the pinned plaintext instead (`preferPin`).
//   - anything on a deleted row. A delete-for-everyone is the sender asking
//     for the message to be gone, and a pin is not a way around that — the
//     thread unpins those rather than restoring them.
import type { Message } from './types';

/** The columns a pin remembers on behalf of the row it was made against. */
export interface RestorablePin {
  media_path: string | null;
  media_type: Message['media_type'];
  /** The caption as it read when the pin was made — '' for a bare picture.
   *  Null on a pin written by a build older than this one, which is what
   *  `restorePinned` treats as "leave the body alone". */
  caption: string | null;
}

/**
 * `messages` with every trimmed-but-pinned row's media columns put back.
 *
 * Returns the input array untouched when nothing needed restoring, and keeps
 * the identity of every row it did not change: this runs on each render of the
 * thread, and a fresh object per message would re-render all of them.
 */
export function restorePinned<T extends Message>(
  messages: readonly T[],
  pins: ReadonlyMap<string, RestorablePin>
): readonly T[] {
  if (pins.size === 0) return messages;

  let changed = false;
  const restored = messages.map((msg) => {
    // A row that still has its media needs nothing; a deleted one must not get
    // it back.
    if (msg.media_path || msg.deleted_at) return msg;
    const pin = pins.get(msg.id);
    if (!pin?.media_path || !pin.media_type) return msg;

    changed = true;
    return {
      ...msg,
      media_path: pin.media_path,
      media_type: pin.media_type,
      // The placeholder body the trim wrote ("📎 media removed") describes a
      // file this device still has, so it is not true here. The caption the
      // message was sent with replaces it; '' collapses to null, which is what
      // the bubble reads as a picture with nothing written under it.
      text: pin.caption === null ? msg.text : pin.caption || null,
      media_restored: true,
    };
  });

  return changed ? restored : messages;
}
