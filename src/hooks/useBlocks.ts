import { useEffect, useSyncExternalStore } from 'react';
import { supabase } from '../lib/supabase';
import { useConnection } from '../lib/connection';
import {
  blockStatus,
  currentBlocks,
  refreshBlocks,
  subscribeBlocks,
  type BlockRow,
  type BlockStatus,
} from '../lib/blocks';

/** The block rows this account is on either side of, kept current. */
export function useBlockRows(): readonly BlockRow[] {
  return useSyncExternalStore(subscribeBlocks, currentBlocks, currentBlocks);
}

export function useBlockStatus(me: string, peer: string): BlockStatus {
  return blockStatus(useBlockRows(), me, peer);
}

/**
 * Keep the store in step with the server. Mounted once, by the chat list,
 * which lives for the whole signed-in session.
 *
 * Re-read on every wake like every other fetch beside a subscription, and on
 * every event rather than patched from the payload: the table is a handful of
 * rows, and an unblock's DELETE carries only what REPLICA IDENTITY sends.
 */
export function useBlocksSync(me: string): void {
  const { generation } = useConnection();

  useEffect(() => {
    void refreshBlocks();
    const channel = supabase
      .channel(`blocks:${me}:${generation}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocks' }, () => {
        void refreshBlocks();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [me, generation]);
}
