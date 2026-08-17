// Attachments: staging them, sealing and uploading each, and trimming the
// conversation's older files back to the keep limits.
//
// Media stays synchronous — there is no outbox for it. Queueing a 50 MB video
// in IndexedDB is a different problem than the text queue solves, and the
// staged-file preview already gives the user feedback while the upload is in
// flight.
//
// A pick of several photos is sent as several messages, one per file, in the
// order they were picked. Each seals its own file key and its own row, so a
// batch is exactly N ordinary sends — nothing that reads messages has to know
// a batch happened.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  classifyMedia,
  conversationFilter,
  fileExtension,
  isSelfChat,
  mediaPath,
  MAX_MESSAGE_LENGTH,
  MEDIA_MAX_BYTES,
} from '../lib/conversation';
import { stageFiles, type StagedMedia } from '../lib/staging';
import { sealBody, sealMediaKey, type BodyColumns } from '../lib/sealed-body';
import { describeMediaError } from '../lib/media-errors';
import { sealFile } from '../lib/media-crypto';
import { peerPublicKey } from '../lib/peer-keys';
import { MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from '../lib/media';
import { pinnedIds } from '../lib/pins';
import { CHAT_IMAGE_MAX_EDGE, compressImageResult } from '../lib/compress';
import { notifyReceiver, notifyRoom } from '../lib/push';
import { roomMediaPath, sealRoomFileKey, sendRoomMessage } from '../lib/rooms';
import { stickerFile, type Sticker } from '../lib/stickers';
import type { Identity } from '../lib/crypto/keys';
import type { MediaType } from '../lib/types';

export interface MediaSend {
  /** The pick waiting on Send, in the order it will be sent. Empty when there
   *  is nothing attached. A voice recording is a queue of exactly one. */
  staged: StagedMedia[];
  uploading: boolean;
  /** How many of the batch are already in, so the composer can count them off
   *  while the rest go up. */
  sentCount: number;
  /** Validate picked/pasted/recorded files and add them to the queue.
   *  `durationMs` is set only for a recording. */
  stage: (files: File | File[], durationMs?: number) => void;
  /** Drop one entry from the queue — the strip's per-thumbnail remove. */
  unstage: (id: string) => void;
  clearStaged: () => void;
  send: (caption: string, replyToId: string | null) => Promise<void>;
  /** Send one sticker on its own. Not part of the staged batch: a sticker is
   *  picked and sent in a single tap, with no caption and nothing to review. */
  sendSticker: (sticker: Sticker, replyToId: string | null) => Promise<void>;
}

/**
 * Where the attachment is going.
 *
 * A union rather than an optional `roomId` beside `peerId`: the two differ in
 * how the file key is sealed (to one recipient, or under the room key), in
 * which table the row lands in, and in whether trimming old media is this
 * device's business at all. Every one of those is a mistake waiting to happen
 * if both fields can be set at once.
 */
export type MediaTarget =
  | { kind: 'peer'; peerId: string; isSelf: boolean }
  /** `roomKey` is null while it is still being opened, and stays null for a
   *  device that has none — the composer is disabled in both cases, and the
   *  upload refuses rather than trusting the caller to have checked. */
  | { kind: 'room'; roomId: string; roomKey: Uint8Array | null };

/** An attachment with no caption. Both columns null, which `has_body` allows
 *  precisely because the row carries a `media_path` instead. */
type NoBody = { ciphertext: null; nonce: null };
/** The file key as the two columns a 1:1 row stores it in. */
type KeyColumns = Awaited<ReturnType<typeof sealMediaKey>>;
/** The file key sealed under a room key, which is a `Sealed` and not columns —
 *  it travels inside the row `sendRoomMessage` signs. */
type SealedFileKey = Awaited<ReturnType<typeof sealRoomFileKey>>;

interface MediaSendOptions {
  me: string;
  target: MediaTarget;
  identity: Identity;
  onStaged: () => void;
  /** Run once the row is in: clear the composer, drop the reply target, take
   *  focus back. */
  onSent: () => void;
  onError: (message: string) => void;
}

export function useMediaSend({
  me,
  target,
  identity,
  onStaged,
  onSent,
  onError,
}: MediaSendOptions): MediaSend {
  const [staged, setStaged] = useState<StagedMedia[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sentCount, setSentCount] = useState(0);

  const targetId = target.kind === 'peer' ? target.peerId : target.roomId;

  useEffect(() => {
    setStaged([]);
    void cleanupOldMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  function stage(files: File | File[], durationMs?: number) {
    const incoming = Array.isArray(files) ? files : [files];
    // Computed outside `setStaged` rather than inside its updater: an updater
    // runs during render and may run twice, so a toast raised from in there
    // fires late, and twice.
    const result = stageFiles(staged, incoming, durationMs);
    setStaged(result.staged);
    if (result.error) onError(result.error);
    if (result.staged.length > staged.length) onStaged();
  }

  function unstage(id: string) {
    setStaged((current) => current.filter((item) => item.id !== id));
  }

  function clearStaged() {
    setStaged([]);
  }

  async function send(caption: string, replyToId: string | null): Promise<void> {
    if (!staged.length) return;
    if (caption.length > MAX_MESSAGE_LENGTH) {
      onError(`Caption is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }

    setUploading(true);
    setSentCount(0);
    // The id of the last row that went in. Only that one raises a push: ten
    // photos are one act of sending, and ten notifications for it is a phone
    // buzzing in someone's pocket ten times.
    let lastInsertedId: string | null = null;
    let sent = 0;

    try {
      for (const [index, item] of staged.entries()) {
        const kind = classifyMedia(item.file);
        if (!kind) {
          onError('Unsupported file type. Use an image, video or voice message.');
          break;
        }
        // The caption and the reply belong to the batch, not to every file in
        // it: repeating them would post the same sentence under each photo and
        // quote the same message N times.
        const insertedId = await uploadStaged(
          item,
          kind,
          index === 0 ? caption : '',
          index === 0 ? replyToId : null
        );
        if (!insertedId) break;
        lastInsertedId = insertedId;
        sent += 1;
        setSentCount(sent);
      }
    } catch (error) {
      // A backstop, not the reporting path: `uploadStaged` handles and names
      // its own failures now. What is left for this to catch is a rejection
      // from somewhere unexpected, which would otherwise escape the submit
      // handler and leave `uploading` true — a composer spinning with no way
      // back and nothing said about why.
      console.error('media send failed', error);
      onError(describeMediaError(error));
    } finally {
      // In `finally`, not after each exit: this flag is what disables the
      // whole composer.
      setUploading(false);
      setSentCount(0);
    }

    // What went in is dropped from the queue; whatever stopped the run stays
    // staged, so Send again retries the rest instead of re-sending the photos
    // the friend already has.
    const remaining = staged.slice(sent);
    setStaged(remaining);
    if (!sent) return;
    // Cleared as soon as anything went in, even if the rest of the batch did
    // not: the caption and the reply rode on the first row. Left in the box
    // they would go again with the retry, posting the same sentence twice and
    // quoting the same message twice.
    onSent();
    if (lastInsertedId) {
      if (target.kind === 'peer') notifyReceiver(lastInsertedId, target.isSelf);
      else notifyRoom(lastInsertedId);
    }
    void cleanupOldMedia();
  }

  /** One file: seal, upload, insert. Returns the new row's id, or null when it
   *  did not go — the batch stops on the first null rather than carrying on
   *  past an error the sender has already been told about.
   *
   *  Split out so `send` owns the `uploading` flag on every path, including a
   *  thrown one.
   *
   *  Two rules hold the order of what follows together, and both are fixes for
   *  the same report — an attachment that refused to send and said only "Could
   *  not send media", with nothing on the device or in the row to say why:
   *
   *  1. Everything that can refuse this send happens **before** the upload.
   *     Reading the file, sealing it, and sealing the row's columns are all
   *     local, all fallible, and used to sit either side of the upload — so a
   *     peer with no published key, the commonest refusal of the lot, was
   *     discovered after the bytes were already in the bucket, where nothing
   *     ever collected them.
   *  2. Nothing throws out of here. Every failure is reported through `fail`,
   *     which names the cause to the sender and puts the underlying error in
   *     the console, where a device log can be read. A rejection escaping to
   *     `send`'s catch loses which file failed and which step it failed at. */
  async function uploadStaged(
    { file, durationMs }: StagedMedia,
    kind: MediaType,
    caption: string,
    replyToId: string | null
  ): Promise<string | null> {
    /** Report and stop. The console line is not decoration: a toast is one
     *  sentence, and a PostgREST code, a DOMException name and a sodium
     *  failure are the three things that tell these apart. */
    const fail = (message: string, error?: unknown): null => {
      if (error !== undefined) console.error('media send failed', error);
      onError(message);
      return null;
    };

    // Narrowed once. Re-reading the union further down does not re-narrow it,
    // which is why the null check on the room key used to be repeated after
    // the upload rather than deciding anything before it.
    const room = target.kind === 'room' ? target : null;
    const peer = target.kind === 'peer' ? target : null;
    const roomKey = room?.roomKey ?? null;
    if (room && !roomKey) return fail('This device has no key for this room.');

    // The same predicate `sealBody` branches on, so the two cannot disagree
    // about whether a key is needed: the self-chat seals under the vault key
    // and has no peer to look one up for.
    let peerKey: Uint8Array | null = null;
    if (peer && !isSelfChat(me, peer.peerId)) {
      try {
        peerKey = await peerPublicKey(peer.peerId);
      } catch (error) {
        return fail(describeMediaError(error), error);
      }
      // Refused here rather than left to `sealBody`'s throw: this is the one
      // send failure a retry cannot fix, and the remedy is the other person's.
      if (!peerKey) {
        return fail(
          'This contact has not published an encryption key yet. Nothing can be sent to them until they open Nearside again on their device.'
        );
      }
    }

    // Images are re-encoded before they leave the device — a phone photo is
    // typically megabytes of resolution this UI never paints. Videos and voice
    // notes go up as recorded (voice is already ~180 KB a minute).
    let body = file;
    if (kind === 'image') {
      const compressed = await compressImageResult(file, { maxEdge: CHAT_IMAGE_MAX_EDGE });
      // Refused here rather than uploaded. A picture this device cannot decode
      // is one no recipient can draw either — the send used to go through and
      // arrive, for everyone including the sender, as "this photo's format
      // can't be shown here", at the one moment nobody could still act on it.
      if (compressed.undecodable) {
        return fail(
          'This image could not be read on this device. Some phones save photos in a format Nearside cannot open. Save or export it as a JPEG and send that.'
        );
      }
      body = compressed.file;
    }

    // The one step in a send with no text-message equivalent, and the one most
    // likely to fail on a phone: pulling the bytes off the device. A gallery
    // item can be a cloud placeholder that was never downloaded, and a content
    // URI's read permission does not always survive the app going to the
    // background behind the picker. Both arrive as a DOMException carrying
    // nothing but a name.
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await body.arrayBuffer());
    } catch (error) {
      return fail(describeMediaError(error), error);
    }

    // Sealed after compression, never before: compressImage decodes an image,
    // and ciphertext does not decode. The key is minted here, travels no
    // further than this function in the clear, and is sealed below — to the
    // recipient in a conversation, under the room key in a room.
    let sealedUpload: Blob;
    let fileKey: Uint8Array;
    try {
      ({ blob: sealedUpload, key: fileKey } = await sealFile(bytes));
    } catch (error) {
      return fail(describeMediaError(error), error);
    }

    // The bucket's own ceiling, checked before the upload rather than left to
    // Storage. The seal adds a nonce and an authentication tag, so a file that
    // staged at exactly the limit is over it by the time it goes up — and
    // finding that out from the server costs the whole upload first.
    if (sealedUpload.size > MEDIA_MAX_BYTES) {
      return fail('That file is too large to send once encrypted.');
    }

    // The extension is kept for the download filename only — the object itself
    // is opaque bytes served as application/octet-stream, so the name is the
    // last thing in Storage that still hints at the file's kind. That is a
    // deliberate, disclosed limit rather than an oversight: the path is already
    // visible to anyone who can list the bucket.
    const filename = `${crypto.randomUUID()}.${fileExtension(body)}`;

    /**
     * Everything the row needs, sealed while nothing has been uploaded yet.
     *
     * A union rather than a bag of nullable fields, for the reason `MediaTarget`
     * is one: the two destinations need different columns, and a shape where
     * both halves can be half-set is a null assertion at the insert waiting to
     * be wrong.
     */
    type Prepared =
      | { kind: 'peer'; peerId: string; path: string; body: BodyColumns | NoBody; key: KeyColumns }
      | { kind: 'room'; roomId: string; roomKey: Uint8Array; path: string; key: SealedFileKey };

    let prepared: Prepared;
    try {
      if (peer) {
        const path = mediaPath(me, peer.peerId, filename);
        prepared = {
          kind: 'peer',
          peerId: peer.peerId,
          path,
          // A caption is body text like any other and is sealed like any other.
          body: caption
            ? await sealBody(identity, peerKey, me, peer.peerId, caption)
            : { ciphertext: null, nonce: null },
          key: await sealMediaKey(identity, peerKey, me, peer.peerId, fileKey),
        };
      } else {
        // Narrowing only: the refusal at the top already returned for a room
        // with no key, and neither branch is reachable without one of the two.
        if (!room || !roomKey) return fail('This device has no key for this room.');
        prepared = {
          kind: 'room',
          roomId: room.roomId,
          roomKey,
          path: roomMediaPath(room.roomId, filename),
          // `sendRoomMessage` seals the caption itself, under the room key.
          key: await sealRoomFileKey(roomKey, fileKey),
        };
      }
    } catch (error) {
      return fail(describeMediaError(error), error);
    }

    const path = prepared.path;
    const { error: uploadError } = await supabase.storage
      .from('chat-media')
      .upload(path, sealedUpload, { contentType: sealedUpload.type });

    if (uploadError) return fail(describeMediaError(uploadError), uploadError);

    /** Undo the upload when the row it belongs to never landed. Without it the
     *  bucket keeps bytes no row points at, and nothing ever collects them. */
    const abandonUpload = async () => {
      await supabase.storage.from('chat-media').remove([path]);
    };

    if (prepared.kind === 'room') {
      try {
        // The same insert an ordinary room message makes, with the media
        // columns filled in — so the signature covers them (v2) without this
        // path knowing how signing works.
        const row = await sendRoomMessage(
          prepared.roomId,
          me,
          identity,
          prepared.roomKey,
          caption || null,
          {
            media: {
              path,
              type: kind,
              durationMs: kind === 'audio' ? durationMs : null,
              key: prepared.key,
            },
            replyToId,
          }
        );
        return row.id;
      } catch (error) {
        await abandonUpload();
        return fail(describeMediaError(error), error);
      }
    }

    // A thrown insert is caught alongside a returned error: supabase-js does
    // not retry writes, so a rejected fetch here is a failed send like any
    // other — and one that leaves an object behind unless it is caught.
    try {
      const { data: inserted, error: insertError } = await supabase
        .from('messages')
        .insert({
          user_id: me,
          receiver_id: prepared.peerId,
          ...prepared.body,
          ...prepared.key,
          media_path: path,
          media_type: kind,
          media_duration_ms: kind === 'audio' ? durationMs : null,
          reply_to_id: replyToId,
        })
        .select('id')
        .single();

      if (insertError) {
        await abandonUpload();
        return fail(describeMediaError(insertError), insertError);
      }
      return inserted?.id ?? null;
    } catch (error) {
      await abandonUpload();
      return fail(describeMediaError(error), error);
    }
  }

  /**
   * Send one sticker.
   *
   * Deliberately the *same* upload path as a photo, with no shortcut of its own:
   * a fresh per-file key, a fresh sealed object in `chat-media`, the key sealed
   * to the recipient on the row. The library copy is not referenced and the
   * server cannot tell this send from any other attachment.
   *
   * That means the same small file goes up again every time it is sent. The
   * alternative — a shared object and a sticker id on the row — would put "who
   * sent which picture to whom, and when" back in plaintext for the one message
   * type where the picture is the whole message. The bytes are the price.
   */
  async function sendSticker(sticker: Sticker, replyToId: string | null): Promise<void> {
    if (uploading) return;
    setUploading(true);
    try {
      const file = await stickerFile(sticker);
      if (!file) {
        onError('That sticker could not be opened on this device.');
        return;
      }
      const id = await uploadStaged({ id: sticker.id, file, durationMs: null }, 'sticker', '', replyToId);
      if (!id) return;
      onSent();
      if (target.kind === 'peer') notifyReceiver(id, target.isSelf);
      else notifyRoom(id);
    } catch (error) {
      console.error('sticker send failed', error);
      onError(describeMediaError(error, 'Could not send that sticker.'));
    } finally {
      setUploading(false);
    }
  }

  /**
   * Trim this conversation's media back to the per-kind keep limits.
   *
   * Conversations only. A room's attachments are shared by everyone in it, and
   * one member's device deciding the room has kept enough photos would delete
   * them out of everybody else's history — a call no single device gets to
   * make. Room media is bounded by the room's disappearing timer instead, which
   * everyone agreed to.
   */
  async function cleanupOldMedia() {
    if (target.kind !== 'peer') return;
    const peerId = target.peerId;
    const { data } = await supabase
      .from('messages')
      .select('id, media_path, user_id, media_type')
      .or(conversationFilter(me, peerId))
      .not('media_path', 'is', null)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(MEDIA_SCAN_LIMIT);

    if (!data) return;

    // Pins are read fresh on every pass rather than held in state: the set
    // changes from the viewer, which is a different component, and a stale
    // copy here would prune the very file someone just chose to keep.
    // Both sides' rows are counted — the keep limit is the conversation's, not
    // one person's — but only our own are acted on.
    const stale = selectStaleMedia(data as MediaRow[], await pinnedIds());
    if (!stale.length) return;

    // Deleting the friend's objects too is what this used to do, and the
    // storage policy allows it: either participant may delete anything in the
    // pair's folder. RLS on `messages` does *not* extend that far, so the row
    // pointing at the file we had just destroyed stayed exactly as it was, with
    // its path and its key intact and nothing behind them. The friend's photo
    // read as deleted forever, on their device and ours, with no way to tell it
    // from a file the server had lost.
    //
    // Each device now trims what it sent and relabels the rows it is allowed to
    // write, so an object and the row naming it always go together. The cost is
    // that a friend who does not open the app leaves their files in the bucket
    // until they do, which is storage — cheap, and recoverable.
    const myStale = stale.filter((m) => m.user_id === me);
    if (!myStale.length) return;

    const paths = myStale.map((m) => m.media_path).filter((p): p is string => !!p);
    if (paths.length) await supabase.storage.from('chat-media').remove(paths);

    // The placeholder names what was trimmed, so a cleared voice note doesn't
    // read as a lost photo.
    const byKind = new Map<string, string[]>();
    for (const row of myStale) {
      const label = row.media_type === 'audio' ? '🎤 voice message removed' : '📎 media removed';
      byKind.set(label, [...(byKind.get(label) ?? []), row.id]);
    }
    const peerKey = await peerPublicKey(peerId);
    for (const [label, ids] of byKind) {
      await supabase
        .from('messages')
        .update({
          media_path: null,
          media_type: null,
          media_duration_ms: null,
          // The file is gone, so the key that opened it describes nothing.
          media_key_ciphertext: null,
          media_key_nonce: null,
          // The placeholder is a body, so it is sealed like one. Written as
          // plaintext it would simply never appear: nothing reads `content`
          // any more, and the bubble would show a decrypt failure where a
          // "media removed" note belongs.
          ...(await sealBody(identity, peerKey, me, peerId, label)),
        })
        .in('id', ids);
    }
  }

  return { staged, uploading, sentCount, stage, unstage, clearStaged, send, sendSticker };
}
