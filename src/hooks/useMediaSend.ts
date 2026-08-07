// Attachments: staging one, sealing and uploading it, and trimming the
// conversation's older files back to the keep limits.
//
// Media stays synchronous — there is no outbox for it. Queueing a 50 MB video
// in IndexedDB is a different problem than the text queue solves, and the
// staged-file preview already gives the user feedback while the upload is in
// flight.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  classifyMedia,
  conversationFilter,
  fileExtension,
  mediaPath,
  MAX_MESSAGE_LENGTH,
  MEDIA_MAX_BYTES,
} from '../lib/conversation';
import { sealBody, sealMediaKey } from '../lib/sealed-body';
import { sealFile } from '../lib/media-crypto';
import { peerPublicKey } from '../lib/peer-keys';
import { MEDIA_SCAN_LIMIT, selectStaleMedia, type MediaRow } from '../lib/media';
import { pinnedIds } from '../lib/pins';
import { CHAT_IMAGE_MAX_EDGE, compressImage } from '../lib/compress';
import { notifyReceiver } from '../lib/push';
import type { Identity } from '../lib/crypto/keys';

export interface MediaSend {
  stagedFile: File | null;
  /** Length of a staged voice recording. Kept beside the file because a
   *  MediaRecorder blob carries no duration of its own, and the composer, the
   *  message row and the bubble all need it. */
  stagedDurationMs: number | null;
  uploading: boolean;
  /** Validate a picked/pasted/recorded file and stage it before sending. */
  stage: (file: File, durationMs?: number) => void;
  clearStaged: () => void;
  send: (caption: string, replyToId: string | null) => Promise<void>;
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
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [stagedDurationMs, setStagedDurationMs] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setStagedFile(null);
    setStagedDurationMs(null);
    void cleanupOldMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId]);

  function stage(file: File, durationMs?: number) {
    if (!classifyMedia(file)) {
      onError('Unsupported file type. Use an image, video or voice message.');
      return;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      onError('File is too large (50 MB max).');
      return;
    }
    setStagedFile(file);
    setStagedDurationMs(durationMs ?? null);
    onStaged();
  }

  function clearStaged() {
    setStagedFile(null);
    setStagedDurationMs(null);
  }

  async function send(caption: string, replyToId: string | null): Promise<void> {
    const file = stagedFile;
    if (!file) return;
    if (caption.length > MAX_MESSAGE_LENGTH) {
      onError(`Caption is too long (${MAX_MESSAGE_LENGTH} characters max).`);
      return;
    }
    const kind = classifyMedia(file);
    if (!kind) {
      onError('Unsupported file type. Use an image, video or voice message.');
      return;
    }

    setUploading(true);
    // Images are re-encoded before they leave the device — a phone photo is
    // typically megabytes of resolution this UI never paints. Videos and voice
    // notes go up as recorded (voice is already ~180 KB a minute).
    const upload =
      kind === 'image' ? await compressImage(file, { maxEdge: CHAT_IMAGE_MAX_EDGE }) : file;

    // Sealed after compression, never before: compressImage decodes an image,
    // and ciphertext does not decode. The key is minted here, travels no
    // further than this function in the clear, and is sealed to the recipient
    // below.
    const peerKey = await peerPublicKey(peerId);
    const { blob: sealedUpload, key: fileKey } = await sealFile(
      new Uint8Array(await upload.arrayBuffer())
    );

    // The extension is kept for the download filename only — the object itself
    // is opaque bytes served as application/octet-stream, so the name is the
    // last thing in Storage that still hints at the file's kind. That is a
    // deliberate, disclosed limit rather than an oversight: the path is already
    // visible to anyone who can list the bucket.
    const path = mediaPath(me, peerId, `${crypto.randomUUID()}.${fileExtension(upload)}`);
    const { error: uploadError } = await supabase.storage
      .from('chat-media')
      .upload(path, sealedUpload, { contentType: sealedUpload.type });

    if (uploadError) {
      setUploading(false);
      onError(uploadError.message);
      return;
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
        media_duration_ms: kind === 'audio' ? stagedDurationMs : null,
        reply_to_id: replyToId,
      })
      .select('id')
      .single();
    setUploading(false);

    if (insertError) {
      await supabase.storage.from('chat-media').remove([path]);
      onError(
        /rate_limited_messages/.test(insertError.message)
          ? "You're sending messages too quickly. Give it a moment."
          : 'Could not send media.'
      );
      return;
    }
    // Sent: clear the composer and staged attachment.
    clearStaged();
    onSent();
    if (inserted) notifyReceiver(inserted.id, isSelf);
    void cleanupOldMedia();
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

  return { stagedFile, stagedDurationMs, uploading, stage, clearStaged, send };
}
