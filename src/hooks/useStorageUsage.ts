import { useCallback, useEffect, useState } from 'react';
import { localDbStats, type LocalDbStats } from '../lib/localdb';
import { pinnedFileSizes } from '../lib/pins';
import { mediaCacheBytes } from '../lib/media-cache';
import { totalPinBytes, type PinTotals } from '../lib/storage-usage';

export interface StorageUsage {
  mirror: LocalDbStats;
  pins: PinTotals;
  /** Decrypted attachments held for this session only. */
  cacheBytes: number;
}

/**
 * What this device is holding, measured on demand.
 *
 * Re-read rather than watched: nothing here changes while the page is open
 * except by an action on the page itself, and a subscription to the filesystem
 * to learn that would be machinery for a number somebody looks at once.
 */
export function useStorageUsage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [mirror, sizes] = await Promise.all([localDbStats(), pinnedFileSizes()]);
      setUsage({ mirror, pins: totalPinBytes(sizes), cacheBytes: mediaCacheBytes() });
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { usage, failed, reload: load };
}
