// A readable URL for one object in the private `chat-media` bucket: sign the
// path, decrypt the bytes, hold the result, and fall back to "no longer
// available" when there is nothing behind it.
//
// A signed URL expires after an hour, and the installed app routinely stays
// open far longer. Without re-signing, an element that reaches for its source
// again after the hour is up (a video seeking, an evicted image re-decoding, a
// voice note played that evening) gets a 400 and paints "Media no longer
// available" for a file sitting right there.
//
// The refresh is reactive rather than timed. Swapping the `src` of a playing
// <audio> or <video> restarts it, so re-signing on a schedule would interrupt
// the one thing most likely to still be running an hour in. The element
// reports its failure instead, and exactly one retry is spent on a fresh URL.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { openFile } from '../lib/media-crypto';
import { keyToken, mimeForPath } from '../lib/media';
import { pinnedObjectUrl } from '../lib/pins';
import type { MediaType } from '../lib/types';

/** Lifetime asked for on each signature. */
const SIGNED_URL_TTL_SECONDS = 3600;

export interface SignedMedia {
  /** The URL to render, or null while the first signature is in flight. */
  url: string | null;
  /** True once the object is believed to be genuinely gone. */
  failed: boolean;
  /**
   * Report that the element could not load `url`. Re-signs once, covering the
   * expired signature, then gives up. Safe to call repeatedly: an element that
   * fails twice settles on `failed` rather than looping.
   */
  reload: () => void;
}

export function useSignedMediaUrl(
  path: string,
  mediaKey?: Uint8Array | null,
  kind?: MediaType | null,
  /** The message this attachment belongs to, so a pruned object can fall back
   *  to the pinned copy on this device. A pin is only worth making if it
   *  survives the pruning it was made against. */
  messageId?: string
): SignedMedia {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The key is depended on by *value*, not identity. `openRows` mints a fresh
  // array on every decrypt and `mergeMessages` replaces the newest row on
  // every poll tick, so an identity dependency re-ran this effect every few
  // seconds: blanking a playing video and re-downloading its bytes for a key
  // that had not changed. The bytes themselves are read through a ref.
  const token = keyToken(mediaKey);
  const keyRef = useRef<Uint8Array | null>(mediaKey ?? null);
  keyRef.current = mediaKey ?? null;
  // The object URL currently handed out, so it can be revoked. A decrypted
  // attachment stays in memory as long as its blob URL does, and the installed
  // app stays open for days: leaking one per rendered image means holding
  // every photo the session has scrolled past.
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);
  // Whether the one retry has been spent for the *current* path. A ref rather
  // than state: `reload` runs from an element's error handler and has to read
  // the answer synchronously, before any re-render.
  const retriedRef = useRef(false);
  // Retires a signature still in flight when the path changes or the component
  // unmounts, so a slow response for the previous attachment cannot paint over
  // the current one.
  const requestRef = useRef(0);

  const sign = useCallback(async () => {
    const ticket = ++requestRef.current;

    /** The pinned plaintext, if this device kept one. Tried whenever the
     *  server copy cannot be produced, which is the whole point of pinning. */
    const fallBackToPin = async (): Promise<boolean> => {
      if (!messageId) return false;
      const pinned = await pinnedObjectUrl(messageId, kind);
      if (!pinned || requestRef.current !== ticket) {
        if (pinned) URL.revokeObjectURL(pinned);
        return false;
      }
      releaseObjectUrl();
      objectUrlRef.current = pinned;
      setUrl(pinned);
      return true;
    };

    const { data, error } = await supabase.storage
      .from('chat-media')
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (requestRef.current !== ticket) return;
    if (error || !data) {
      if (!(await fallBackToPin())) setFailed(true);
      return;
    }

    // No key: a row written before 0024, or one this device cannot open.
    // Nothing to decrypt and nothing to show. A signed URL to ciphertext would
    // render as a broken image, which reads as a lost file rather than as the
    // encryption working.
    const key = keyRef.current;
    if (!key) {
      if (!(await fallBackToPin())) setFailed(true);
      return;
    }

    try {
      const response = await fetch(data.signedUrl);
      if (!response.ok) throw new Error(String(response.status));
      const opened = await openFile(new Uint8Array(await response.arrayBuffer()), key);
      if (requestRef.current !== ticket) return;

      // Revoke before replacing, or a re-sign after an expiry strands the old
      // blob for the tab's lifetime.
      releaseObjectUrl();
      // Typed from the object name, because Storage cannot say: every sealed
      // object uploads as application/octet-stream. A typeless blob leaves
      // videos showing a blank poster and renders an image as garbage text.
      //
      // Copied into a fresh buffer, since `opened` may be a view libsodium
      // hands back over a larger allocation that Blob would carry whole.
      const blobUrl = URL.createObjectURL(
        new Blob([opened.slice()], { type: mimeForPath(path, kind) })
      );
      objectUrlRef.current = blobUrl;
      setUrl(blobUrl);
    } catch {
      if (requestRef.current !== ticket) return;
      if (!(await fallBackToPin())) setFailed(true);
    }
    // `token` is listed on purpose. The rule is right that the body never
    // reads it: it stands in for `keyRef.current`, which the body does read
    // and the rule cannot see through. Dropping it pins this callback to the
    // first key it ever saw; a plain `mediaKey` dependency reintroduces the
    // re-decrypt loop described at the ref's declaration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, kind, messageId, releaseObjectUrl]);

  useEffect(() => {
    setUrl(null);
    setFailed(false);
    retriedRef.current = false;
    void sign();
    return () => {
      // Bumping the ticket is what makes the in-flight signature a no-op.
      //
      // The exhaustive-deps rule flags `ref.current` reads in a cleanup because
      // a ref holding a DOM node is usually stale by then. This one holds a
      // request counter meant to be read at exactly this moment. Copying it to
      // a local, as the rule suggests, compares the ticket against a snapshot
      // of itself and retires nothing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestRef.current++;
      releaseObjectUrl();
    };
  }, [sign, releaseObjectUrl]);

  const reload = useCallback(() => {
    if (retriedRef.current) {
      setFailed(true);
      return;
    }
    retriedRef.current = true;
    setUrl(null);
    void sign();
  }, [sign]);

  return { url, failed, reload };
}
