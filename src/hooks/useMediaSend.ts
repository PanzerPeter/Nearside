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
  mediaPath,
  MAX_MESSAGE_LENGTH,
} from '../lib/conversation';
import { stageFiles, type StagedMedia } from '../lib/staging';
import { sealBody, sealMediaKey } from '../lib/sealed-body';
import { sealFile } from '../lib/media-crypto';
import { peerPublicKey } from '../lib/peer-keys';
import { MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from '../lib/media';
import { pinnedIds } from '../lib/pins';
import { CHAT_IMAGE_MAX_EDGE, compressImage } from '../lib/compress';
import { notifyReceiver } from '../lib/push';
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

interface MediaSendOptions {
  me: string;
  peerId: string;
  isSelf: boolean;
  identity: Identity;
  onStaged: () => void;
  /** Run once the row is in: clear the composer, drop the reply target, take
   *  focus back. */
  onSent: () => void;
  onError: (message: string) => void;
}

export function useMediaSend({
  me,
  peerId,
  isSelf,
  identity,
  onStaged,
  onSent,
  onError,
}: MediaSendOptions): MediaSend {
  const [staged, setStaged] = useState<StagedMedia[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sentCount, setSentCount] = useState(0);

  useEffect(() => {
    setStaged([]);
    void cleanupOldMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId]);

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
    } catch {
      // `sealBody` throws outright when the peer has published no key, and
      // `compressImage` can throw on an image the decoder refuses. Neither
      // used to be caught: the rejection escaped the submit handler and left
      // `uploading` true, so the composer sat spinning with no way back and
      // nothing said about why.
      onError('Could not send media.');
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
    if (lastInsertedId) notifyReceiver(lastInsertedId, isSelf);
    void cleanupOldMedia();
  }

  /** One file: seal, upload, insert. Returns the new row's id, or null when it
   *  did not go — the batch stops on the first null rather than carrying on
   *  past an error the sender has already been told about.
   *
   *  Split out so `send` owns the `uploading` flag on every path, including a
   *  thrown one. */
  async function uploadStaged(
    { file, durationMs }: StagedMedia,
    kind: MediaType,
    caption: string,
    replyToId: string | null
  ): Promise<string | null> {
    // Images are re-encoded before they leave the device — a phone photo is
    // typically megabytes of resolution this UI never paints. Videos and voice
    // notes go up as recorded (voice is already ~180 KB a minute).
    const body =
      kind === 'image' ? await compressImage(file, { maxEdge: CHAT_IMAGE_MAX_EDGE }) : file;

    // Sealed after compression, never before: compressImage decodes an image,
    // and ciphertext does not decode. The key is minted here, travels no
    // further than this function in the clear, and is sealed to the recipient
    // below.
    const peerKey = await peerPublicKey(peerId);
    const { blob: sealedUpload, key: fileKey } = await sealFile(
      new Uint8Array(await body.arrayBuffer())
    );

    // The extension is kept for the download filename only — the object itself
    // is opaque bytes served as application/octet-stream, so the name is the
    // last thing in Storage that still hints at the file's kind. That is a
    // deliberate, disclosed limit rather than an oversight: the path is already
    // visible to anyone who can list the bucket.
    const path = mediaPath(me, peerId, `${crypto.randomUUID()}.${fileExtension(body)}`);
    const { error: uploadError } = await supabase.storage
      .from('chat-media')
      .upload(path, sealedUpload, { contentType: sealedUpload.type });

    if (uploadError) {
      onError(uploadError.message);
      return null;
    }

    const { data: inserted, error: insertError } = await supabase
      .from('messages')
      .insert({
        user_id: me,
        receiver_id: peerId,
        // A caption is body text like any other and is sealed like any other.
        ...(caption
          ? await sealBody(identity, peerKey, me, peerId, caption)
          : { ciphertext: null, nonce: null }),
        ...(await sealMediaKey(identity, peerKey, me, peerId, fileKey)),
        media_path: path,
        media_type: kind,
        media_duration_ms: kind === 'audio' ? durationMs : null,
        reply_to_id: replyToId,
      })
      .select('id')
      .single();

    if (insertError) {
      await supabase.storage.from('chat-media').remove([path]);
      onError(
        /rate_limited_messages/.test(insertError.message)
          ? "You're sending messages too quickly. Give it a moment."
          : 'Could not send media.'
      );
      return null;
    }
    return inserted?.id ?? null;
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
      notifyReceiver(id, isSelf);
    } catch {
      onError('Could not send that sticker.');
    } finally {
      setUploading(false);
    }
  }

  /** Trim this conversation's media back to the per-kind keep limits. */
  async function cleanupOldMedia() {
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
    const stale = selectStaleMedia(data as MediaRow[], await pinnedIds());
    if (!stale.length) return;

    const paths = stale.map((m) => m.media_path).filter((p): p is string => !!p);
    if (paths.length) await supabase.storage.from('chat-media').remove(paths);

    // RLS lets us edit only our own rows; the friend's rows degrade gracefully
    // (the attachment and voice-note components both show a "no longer
    // available" fallback).
    const myStale = stale.filter((m) => m.user_id === me);
    if (!myStale.length) return;

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
