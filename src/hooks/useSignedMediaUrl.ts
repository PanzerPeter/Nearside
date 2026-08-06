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

/** Lifetime asked for on each signature. */
export const SIGNED_URL_TTL_SECONDS = 3600;

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

export function useSignedMediaUrl(path: string): SignedMedia {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
    const { data, error } = await supabase.storage
      .from('chat-media')
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (requestRef.current !== ticket) return;
    if (error || !data) {
      setFailed(true);
      return;
    }
    setUrl(data.signedUrl);
  }, [path]);

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
    };
  }, [sign]);

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
