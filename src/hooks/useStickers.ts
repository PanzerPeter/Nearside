// The sticker drawer: fetch, open, upload, delete.
//
// Everything sealed comes back sealed from `lib/stickers.ts`; this is the layer
// that holds an identity, so this is where it is opened — the same split
// `useSealedExchange` and `ChatRoom.open` use.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapWithLimit } from '../lib/pool';
import { planReorder } from '../lib/reorder';
import { recentStickerIds, recordStickerUse, resolveRecents } from '../lib/sticker-recents';
import {
  deleteSticker,
  forgetSticker,
  listStickers,
  nextSort,
  openStickers,
  saveStickerOrder,
  sortStickers,
  stickerRejection,
  stickerUrl,
  uploadSticker,
  STICKER_FETCH_CONCURRENCY,
  STICKER_LIMIT,
  type Sticker,
} from '../lib/stickers';
import type { Identity } from '../lib/crypto/keys';

export interface StickerDrawer {
  stickers: Sticker[];
  /** Object URLs by sticker id, filled in as each is fetched and decrypted.
   *  A missing entry means "still loading", not "broken". */
  urls: Record<string, string>;
  loading: boolean;
  /** Whether the library is at its ceiling, so the upload tile can say so
   *  instead of failing after the file picker. */
  full: boolean;
  add: (file: File, label: string) => Promise<string | null>;
  remove: (sticker: Sticker) => Promise<void>;
  /** Move one sticker to another's place, by id. Applied to the grid at once
   *  and written behind it — a drag that waited for a round trip per frame
   *  would not feel like dragging. */
  reorder: (fromId: string, toId: string) => void;
  reload: () => Promise<void>;
  /** Start loading. Called by the picker when it mounts — see below. */
  activate: () => void;
  /** The stickers this device reached for most recently, newest first, already
   *  resolved against the library. Empty until one has been sent from here —
   *  the shelf is not drawn at all until it has something to hold. */
  recent: Sticker[];
  /** Record that one was sent. Called by the picker rather than by the send,
   *  because it is the *choosing* that this remembers: a sticker forwarded on
   *  from somewhere else was never picked out of the drawer. */
  noteUse: (sticker: Sticker) => void;
}

export function useStickers(userId: string | null, identity: Identity | null): StickerDrawer {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  // Seeded from the device rather than fetched: the shelf is local by design
  // (see `lib/sticker-recents.ts`), so it is already there on the first render.
  const [recentIds, setRecentIds] = useState<string[]>(() => recentStickerIds(userId));
  useEffect(() => setRecentIds(recentStickerIds(userId)), [userId]);
  /**
   * Whether the drawer has been opened at all this session.
   *
   * This hook lives in `ChatRoom`, so it mounts with every conversation — and
   * it used to list the library and then download and decrypt *every* sticker
   * on that mount. A hundred stickers is a hundred objects fetched to draw a
   * grid most sessions never open, before the user has touched the button that
   * shows it. The picker asks for the library when it appears instead.
   */
  const [active, setActive] = useState(false);

  const reload = useCallback(async () => {
    if (!userId || !identity) {
      setStickers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const opened = await openStickers(identity, await listStickers(userId));
    setStickers(sortStickers(opened));
    setLoading(false);
  }, [userId, identity]);

  useEffect(() => {
    if (!active) return;
    void reload();
  }, [active, reload]);

  /**
   * Stickers whose bytes have already been asked for.
   *
   * This effect re-runs on every change to the list, and a drag changes the
   * list on every tile the finger crosses — without this, one reorder gesture
   * re-walks the whole library a dozen times, allocating a fetch per sticker
   * per frame to discover they are all cached. A ref rather than state because
   * nothing renders from it.
   */
  const requested = useRef(new Set<string>());

  // Bytes are fetched per sticker rather than as one batch: the cache in
  // `lib/stickers.ts` is module-level, so a second open of the drawer resolves
  // every one of these immediately and nothing is refetched.
  //
  // A few at a time, not all of them. Storage downloads sit outside the read
  // queue by design (`net-queue.ts`), so a hundred-sticker library opened at
  // the same moment as the emoji panel is a hundred GETs competing with it —
  // and the first row of tiles, the only one on screen, arrives last.
  useEffect(() => {
    const asked = requested.current;
    const pending = stickers.filter((s) => s.key && !asked.has(s.id));
    if (pending.length === 0) return;
    for (const sticker of pending) asked.add(sticker.id);

    let cancelled = false;
    const arrived = new Set<string>();
    void mapWithLimit(
      pending,
      STICKER_FETCH_CONCURRENCY,
      async (sticker) => {
        const url = await stickerUrl(sticker);
        if (cancelled || !url) return;
        arrived.add(sticker.id);
        setUrls((current) =>
          current[sticker.id] === url ? current : { ...current, [sticker.id]: url }
        );
      },
      () => cancelled
    );
    return () => {
      cancelled = true;
      // Whatever the cancel caught has to be askable again, or a picker closed
      // during the first load leaves those tiles blank for the rest of the
      // session — the ref would still be claiming they were fetched.
      for (const sticker of pending) {
        if (!arrived.has(sticker.id)) asked.delete(sticker.id);
      }
    };
  }, [stickers]);

  /** Returns an error message, or null when the sticker went in. */
  const add = useCallback(
    async (file: File, label: string): Promise<string | null> => {
      if (!userId || !identity) return 'Not ready yet.';
      if (stickers.length >= STICKER_LIMIT) return `You can keep ${STICKER_LIMIT} stickers.`;
      const rejection = stickerRejection(file);
      if (rejection) return rejection;
      try {
        const added = await uploadSticker(identity, userId, file, label, nextSort(stickers));
        setStickers((current) => sortStickers([...current, added]));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : 'Could not add that sticker.';
      }
    },
    [userId, identity, stickers]
  );

  const remove = useCallback(async (sticker: Sticker) => {
    // Dropped from state first so the tile goes immediately; the round trip is
    // slow enough on a phone to read as an ignored tap.
    setStickers((current) => current.filter((s) => s.id !== sticker.id));
    setUrls((current) => {
      const next = { ...current };
      delete next[sticker.id];
      return next;
    });
    requested.current.delete(sticker.id);
    forgetSticker(sticker.id);
    await deleteSticker(sticker.id, sticker.path);
  }, []);

  const reorder = useCallback((fromId: string, toId: string) => {
    setStickers((current) => {
      const from = current.findIndex((s) => s.id === fromId);
      const to = current.findIndex((s) => s.id === toId);
      if (from < 0 || to < 0 || from === to) return current;
      // Written against the order the user just made, not against `current`
      // read back later: another drag can land before this settles, and the
      // second write is then the one that wins — which is the right one.
      const { next, positions } = planReorder(current, from, to);
      if (positions.length > 0) void saveStickerOrder(positions);
      return next;
    });
  }, []);

  const activate = useCallback(() => setActive(true), []);

  // Resolved here rather than in the picker so a sticker deleted on another
  // device leaves the shelf as soon as the library reloads, with no second
  // place holding a list of ids that may no longer name anything.
  const recent = useMemo(() => resolveRecents(recentIds, stickers), [recentIds, stickers]);

  function noteUse(sticker: Sticker) {
    setRecentIds(recordStickerUse(userId, sticker.id));
  }

  return {
    stickers,
    urls,
    loading,
    full: stickers.length >= STICKER_LIMIT,
    reorder,
    add,
    remove,
    reload,
    activate,
    recent,
    noteUse,
  };
}
