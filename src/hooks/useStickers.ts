// The sticker drawer: fetch, open, upload, delete.
//
// Everything sealed comes back sealed from `lib/stickers.ts`; this is the layer
// that holds an identity, so this is where it is opened — the same split
// `useSealedExchange` and `ChatRoom.open` use.

import { useCallback, useEffect, useState } from 'react';
import {
  deleteSticker,
  forgetSticker,
  listStickers,
  nextSort,
  openStickers,
  sortStickers,
  stickerRejection,
  stickerUrl,
  uploadSticker,
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
  reload: () => Promise<void>;
}

export function useStickers(userId: string | null, identity: Identity | null): StickerDrawer {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

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
    void reload();
  }, [reload]);

  // Bytes are fetched per sticker rather than as one batch: the cache in
  // `lib/stickers.ts` is module-level, so a second open of the drawer resolves
  // every one of these immediately and nothing is refetched.
  useEffect(() => {
    let cancelled = false;
    for (const sticker of stickers) {
      if (!sticker.key) continue;
      void stickerUrl(sticker).then((url) => {
        if (cancelled || !url) return;
        setUrls((current) => (current[sticker.id] === url ? current : { ...current, [sticker.id]: url }));
      });
    }
    return () => {
      cancelled = true;
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
    forgetSticker(sticker.id);
    await deleteSticker(sticker.id, sticker.path);
  }, []);

  return { stickers, urls, loading, full: stickers.length >= STICKER_LIMIT, add, remove, reload };
}
