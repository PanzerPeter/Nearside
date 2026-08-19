// A readable URL for one object in the private `chat-media` bucket: read the
// session cache, else sign the path, decrypt the bytes, hold the result, and
// report *why* when one of those cannot be done — see `MediaFailure`. The
// reason is carried rather than flattened to a boolean because "the file was
// deleted", "this device has no key" and "this build cannot decode it" are
// three different problems, and only the first is the user's file being gone.
//
// A signed URL expires after an hour, and the installed app routinely stays
// open far longer. Without re-signing, an element that reaches for its source
// again after the hour is up (a video seeking, an evicted image re-decoding, a
// voice note played that evening) gets a 400 and paints a failure notice for a
// file sitting right there.
//
// The refresh is reactive rather than timed. Swapping the `src` of a playing
// <audio> or <video> restarts it, so re-signing on a schedule would interrupt
// the one thing most likely to still be running an hour in. The element
// reports its failure instead, and exactly one retry is spent on a fresh URL.
//
// Two things keep this off the network. `lib/media-cache.ts` owns the decrypted
// blob for the session, so the same object is fetched once however many
// components ask for it and however often the thread is scrolled past it. And
// `defer` holds the first fetch until the attachment is near the viewport: a
// page is thirty messages and a screen is about five, so an eager thread of
// photos downloaded five times what anybody looked at.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { openFile } from '../lib/media-crypto';
import { imageDecodes } from '../lib/compress';
import { keyToken, mimeForPath, type MediaFailure } from '../lib/media';
import { cachedMedia, forgetMedia, putMedia } from '../lib/media-cache';
import { pinnedObjectUrl } from '../lib/pins';
import type { MediaType } from '../lib/types';

/** Lifetime asked for on each signature. */
const SIGNED_URL_TTL_SECONDS = 3600;

/** How far outside the viewport a deferred attachment starts loading. Wide
 *  enough that an ordinary scroll never meets a placeholder, narrow enough that
 *  opening a conversation does not fetch the whole page. */
const PRELOAD_MARGIN = '800px';

/** How many fresh signatures one attachment may spend before the element's
 *  refusals are taken as final. Two, because the failure being covered — a
 *  cache eviction revoking a live URL — can legitimately happen more than
 *  once, and each round costs one download. */
const MAX_RELOADS = 2;

export interface SignedMedia {
  /** The URL to render, or null while the first signature is in flight. */
  url: string | null;
  /** Why the attachment cannot be shown, or null while it still can be. */
  failure: MediaFailure | null;
  /**
   * Report that the element could not load `url`. Re-fetches once — the URL an
   * element is given is a blob URL the media cache owns, and an eviction
   * revokes it — then gives up. Safe to call repeatedly: an element that fails
   * twice settles on a failure rather than looping.
   *
   * The second failure is what identifies an undecodable file. The retry hands
   * the element bytes this device downloaded and decrypted a moment ago, so an
   * element that refuses *those* is not looking at a missing object; it has no
   * decoder for what it was given.
   */
  reload: () => void;
  /**
   * Attach to the placeholder rendered while `url` is null. Under `defer` it is
   * what decides the fetch has become worth making; without it a deferred
   * attachment never loads at all.
   */
  probeRef: (el: Element | null) => void;
}

export function useSignedMediaUrl(
  path: string,
  mediaKey?: Uint8Array | null,
  kind?: MediaType | null,
  /** The message this attachment belongs to, so a pruned object can fall back
   *  to the pinned copy on this device. A pin is only worth making if it
   *  survives the pruning it was made against. */
  messageId?: string,
  /** Wait until the placeholder is near the viewport before fetching. Set by
   *  the components that render a placeholder of the right size — anything that
   *  reserves no space would load everything at once anyway. */
  defer = false,
  /** These media columns came back from a pin rather than from the server
   *  (`lib/pin-restore.ts`), so the object they name was deleted by the sender's
   *  trim. Go to the pinned copy first: signing a URL for it would spend a round
   *  trip to be told what is already known, on every mount, forever. */
  preferPin = false
): SignedMedia {
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  // Whether the attachment has come close enough to the viewport to be worth
  // fetching. Starts true when nothing is deferring it, and when the platform
  // has no IntersectionObserver — a missing API must mean "load it", never
  // "never load it".
  const [wanted, setWanted] = useState(!defer || typeof IntersectionObserver === 'undefined');
  // The key is depended on by *value*, not identity. `openRows` mints a fresh
  // array on every decrypt and `mergeMessages` replaces the newest row on
  // every poll tick, so an identity dependency re-ran this effect every few
  // seconds: blanking a playing video and re-downloading its bytes for a key
  // that had not changed. The bytes themselves are read through a ref.
  const token = keyToken(mediaKey);
  const keyRef = useRef<Uint8Array | null>(mediaKey ?? null);
  keyRef.current = mediaKey ?? null;
  // A URL this hook owns and must revoke, as opposed to one the media cache
  // owns. Only the pinned-copy fallback mints one now: a decrypted object goes
  // into the cache, where the thumbnail, the viewer opened over it and the same
  // file forwarded elsewhere all read the one blob.
  const ownedUrlRef = useRef<string | null>(null);

  const releaseOwnedUrl = useCallback(() => {
    if (ownedUrlRef.current) {
      URL.revokeObjectURL(ownedUrlRef.current);
      ownedUrlRef.current = null;
    }
  }, []);
  // How many re-signs the current path has spent. A ref rather than state:
  // `reload` runs from an element's error handler and has to read the answer
  // synchronously, before any re-render.
  const retriesRef = useRef(0);
  // Whether these bytes were proved to decode here. It is what separates an
  // element that keeps losing its URL from a file with no decoder — the two
  // used to be the same event counted twice.
  const decodedRef = useRef(false);
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
      releaseOwnedUrl();
      ownedUrlRef.current = pinned;
      setUrl(pinned);
      return true;
    };

    /** Give up with a reason, unless this device kept a pinned copy — a pin is
     *  an answer to every one of these. */
    const giveUp = async (reason: MediaFailure) => {
      if (!(await fallBackToPin())) setFailure(reason);
    };

    // The pinned copy is the whole source for a restored row. If it has gone
    // too — a cleared cache, a restore that did not carry the sandbox — the
    // ordinary path below still runs and reports honestly why there is nothing
    // to show.
    if (preferPin && (await fallBackToPin())) return;

    const { data, error } = await supabase.storage
      .from('chat-media')
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (requestRef.current !== ticket) return;
    if (error || !data) {
      await giveUp('gone');
      return;
    }

    // No key: a row written before 0024, or one this device cannot open.
    // Nothing to decrypt and nothing to show. A signed URL to ciphertext would
    // render as a broken image, which reads as a lost file rather than as the
    // encryption working.
    const key = keyRef.current;
    if (!key) {
      await giveUp('sealed');
      return;
    }

    // The download and the decrypt are caught separately because they fail for
    // opposite reasons and the notice has to say which: a 404 is a file that
    // was removed, where a secretbox that will not open is a key this device
    // cannot use on bytes that are still there.
    let sealed: Uint8Array;
    try {
      const response = await fetch(data.signedUrl);
      if (!response.ok) throw new Error(String(response.status));
      sealed = new Uint8Array(await response.arrayBuffer());
    } catch {
      if (requestRef.current !== ticket) return;
      await giveUp('gone');
      return;
    }

    let blob: Blob;
    try {
      const opened = await openFile(sealed, key);
      if (requestRef.current !== ticket) return;

      // Typed from the object name, because Storage cannot say: every sealed
      // object uploads as application/octet-stream. A typeless blob leaves
      // videos showing a blank poster and renders an image as garbage text.
      //
      // Copied into a fresh buffer, since `opened` may be a view libsodium
      // hands back over a larger allocation that Blob would carry whole.
      blob = new Blob([opened.slice()], { type: mimeForPath(path, kind) });
    } catch {
      if (requestRef.current !== ticket) return;
      await giveUp('sealed');
      return;
    }

    // Asked of the bytes themselves, once, rather than inferred from an
    // element that refused to load twice: the media cache revokes a URL under
    // whatever is pointing at it on every eviction, and counting that as
    // evidence about the *format* condemned photos that were never broken.
    // Only the still kinds are asked — there is no cheap way to put the same
    // question to a video, which is what `videoTrackIsUnsupported` is for.
    if ((kind === 'image' || kind === 'sticker') && !(await imageDecodes(blob))) {
      if (requestRef.current !== ticket) return;
      console.warn('media has no decoder here', { path, type: blob.type, bytes: blob.size });
      setFailure('undecodable');
      return;
    }
    if (requestRef.current !== ticket) return;

    decodedRef.current = true;
    releaseOwnedUrl();
    setUrl(putMedia(path, blob));
    // `token` is listed on purpose. The rule is right that the body never
    // reads it: it stands in for `keyRef.current`, which the body does read
    // and the rule cannot see through. Dropping it pins this callback to the
    // first key it ever saw; a plain `mediaKey` dependency reintroduces the
    // re-decrypt loop described at the ref's declaration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, kind, messageId, preferPin, releaseOwnedUrl]);

  // Attachment-scoped state, reset when this component is pointed at a
  // different object.
  useEffect(() => {
    setFailure(null);
    retriesRef.current = 0;
    decodedRef.current = false;
    setWanted(!defer || typeof IntersectionObserver === 'undefined');
  }, [path, defer]);

  // The load itself. Deliberately *not* gated on the `url` state: that value is
  // this render's, so on a path change it still holds the previous
  // attachment's URL, and an effect that reads it as "already loaded" would
  // never fetch the new one. The cache is consulted here instead, which answers
  // the same question about the path actually being asked for.
  useEffect(() => {
    // A hit costs nothing and is taken whether or not the attachment is near
    // the viewport: the bytes are already in memory, so deferring one the
    // session has decrypted would paint a placeholder over a picture it could
    // show this frame.
    const hit = cachedMedia(path);
    setUrl(hit);
    if (hit || !wanted) return;

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
      releaseOwnedUrl();
    };
  }, [path, wanted, sign, releaseOwnedUrl]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const probeRef = useCallback(
    (el: Element | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el || typeof IntersectionObserver === 'undefined') return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          observer.disconnect();
          setWanted(true);
        },
        { rootMargin: PRELOAD_MARGIN }
      );
      observer.observe(el);
      observerRef.current = observer;
    },
    []
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const reload = useCallback(() => {
    if (retriesRef.current >= MAX_RELOADS) {
      // Out of retries. What that means depends on something already known:
      // bytes that decoded here are a URL problem and not a format one, and
      // saying "this format can't be shown" about a picture this device drew a
      // moment ago is the wrong sentence and an unrecoverable one — `failure`
      // sticks until the path changes.
      setFailure(decodedRef.current ? 'gone' : 'undecodable');
      return;
    }
    retriesRef.current += 1;
    // The cached blob is what just failed to render — an eviction revoked it,
    // or the object behind it is gone. Left in place, the re-sign below would
    // be answered by the same dead URL on the next mount.
    forgetMedia(path);
    setUrl(null);
    void sign();
  }, [sign, path]);

  return { url, failure, reload, probeRef };
}
