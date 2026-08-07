// A readable URL for one object in the private `chat-media` bucket.
//
// Every consumer of that bucket needs the same three things — sign the path,
// hold the result, and fall back to a "no longer available" state when there is
// nothing behind it — and each of them had written its own copy. The copies had
// drifted only in trivia (which state was cleared on a path change), but they
// shared one real gap, which is the reason this exists rather than being pure
// tidying:
//
// A signed URL expires after an hour. The installed PWA and a pinned tab both
// routinely stay open far longer than that, and nothing re-signed — so an
// element that reached for its source again after the hour was up (a video
// seeking, an image the browser had evicted and re-decoded, a voice note played
// for the first time that evening) got a 400 and painted "Media no longer
// available" for a file that is sitting right there.
//
// The refresh is deliberately reactive rather than a timer. Swapping the `src`
// of a playing <audio> or <video> restarts it, so re-signing on a schedule
// would interrupt the one thing most likely to still be running an hour in.
// Instead the element tells us it failed, and we spend exactly one retry on a
// fresh URL before believing it.

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
   * Report that the element could not load `url`. Re-signs once — covering the
   * expired-signature case — and only then gives up. Safe to call repeatedly:
   * an element that fails twice settles on `failed` instead of looping.
   */
  reload: () => void;
}

export function useSignedMediaUrl(
  path: string,
  mediaKey?: Uint8Array | null,
  kind?: MediaType | null,
  /** The message this attachment belongs to. Supplied so a pruned object can
   *  fall back to the pinned copy on this device — a pin is only worth making
   *  if it survives the pruning it was made against. */
  messageId?: string
): SignedMedia {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The key is depended on by *value*, not by identity. `openRows` mints a
  // fresh array on every decrypt and `mergeMessages` replaces the newest row
  // with a freshly-decrypted copy on every poll tick, so an identity
  // dependency re-ran this effect every few seconds — blanking a playing
  // video, re-downloading its bytes and decrypting them again for a key that
  // had not changed. The bytes themselves are read through a ref.
  const token = keyToken(mediaKey);
  const keyRef = useRef<Uint8Array | null>(mediaKey ?? null);
  keyRef.current = mediaKey ?? null;
  // The object URL currently handed out, so it can be revoked. A decrypted
  // attachment lives in browser memory for as long as its blob URL does, and
  // the installed PWA stays open for days — leaking one per rendered image is
  // how a session ends up holding every photo it has scrolled past.
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);
  // Whether the one retry has been spent, for the *current* path. A ref, not
  // state: `reload` is called from an element's error handler and has to read
  // the answer synchronously, before any re-render.
  const retriedRef = useRef(false);
  // Retires the result of a signature still in flight when the path changes or
  // the component unmounts — otherwise a slow response for the previous
  // attachment paints over the current one.
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

    // No key: either a row written before 0024, or one this device cannot
    // open. Either way there is nothing to decrypt and nothing to show — a
    // signed URL to ciphertext would render as a broken image, which reads as
    // a lost file rather than as the encryption working.
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

      // Revoke the previous one before replacing it — a re-sign after an
      // expiry would otherwise strand the old blob for the tab's lifetime.
      releaseObjectUrl();
      // Typed from the object name, because Storage cannot say: every sealed
      // object is uploaded as application/octet-stream. A typeless blob is
      // what left videos showing a blank poster instead of a first frame, and
      // made an image opened on its own render as a page of garbage text.
      //
      // Copied into a fresh buffer: `opened` is a view libsodium may hand back
      // over a larger allocation, and Blob would carry the whole thing.
      const blobUrl = URL.createObjectURL(
        new Blob([opened.slice()], { type: mimeForPath(path, kind) })
      );
      objectUrlRef.current = blobUrl;
      setUrl(blobUrl);
    } catch {
      if (requestRef.current !== ticket) return;
      if (!(await fallBackToPin())) setFailed(true);
    }
    // `token` is listed on purpose, and the rule is right that the body never
    // reads it: it stands in for `keyRef.current`, which the body does read
    // and which the rule cannot see through. Dropping it would pin this
    // callback to the first key it ever saw. Reverting to a plain `mediaKey`
    // dependency is what caused the bug — see the ref's declaration.
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
      // The exhaustive-deps rule flags any `ref.current` read in a cleanup,
      // because for a ref holding a *DOM node* the node is usually gone by
      // then. This one holds a request counter whose whole purpose is to be
      // read at exactly this moment: "later than when the effect ran" is the
      // condition being detected, not a hazard. Copying it to a local, which
      // is what the rule suggests, would compare the ticket against a snapshot
      // of itself and retire nothing.
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
