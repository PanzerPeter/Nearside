import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { Session, RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { conversationKey } from '../lib/conversation';
import { useConnection } from '../lib/connection';
import { isAppActive, subscribeAppActive } from '../lib/app-active';
import {
  PeerMeta,
  PeerTrack,
  PresenceStatus,
  resolveStatus,
  trackPeers,
} from '../lib/presence-model';

// Re-broadcast our own status this often so peers' `updated_at` stays fresh
// even when no state change fires.
const HEARTBEAT_MS = 25_000;
// How often observers re-evaluate freshness, so a peer expires with no event.
// Shorter than the graces in `presence-model` — a dot that only settles on the
// next tick after the grace has run out reads as a slow app, not a careful one.
const TICK_MS = 8_000;

/** Live tracks for every peer we have heard from, plus a ticking clock. */
interface PresenceView {
  tracks: Map<string, PeerTrack>;
  now: number;
}

const PresenceContext = createContext<PresenceView>({ tracks: new Map(), now: 0 });

/** Own status: in front of the user, or merely running. `app-active` is what
 *  knows — on a phone the DOM's answer is wrong. */
function selfStatus(): PeerMeta['status'] {
  return isAppActive() ? 'active' : 'background';
}

/**
 * Broadcasts this device's presence to each friend and exposes a live map of
 * their statuses. A user may be connected from several devices; the strongest
 * signal wins (active > background > offline).
 *
 * One channel per friendship rather than one app-wide room. A single shared
 * channel meant every account received every other account's user id and
 * activity — a stranger's online/offline pattern is not the app's to publish,
 * and the fanout grows with the whole user base rather than with your friends.
 * Each pair channel carries exactly two members, so a peer's presence reaches
 * only people they have actually accepted.
 *
 * What the peers' statuses *mean* lives in `lib/presence-model.ts`; this
 * provider only feeds it what the socket said and when.
 */
export function PresenceProvider({
  session,
  friendIds,
  children,
}: {
  session: Session;
  /** Accepted friends to exchange presence with. */
  friendIds: string[];
  children: ReactNode;
}) {
  const me = session.user.id;
  const [view, setView] = useState<PresenceView>(() => ({ tracks: new Map(), now: Date.now() }));
  // Peer tracks outlive the effect below. A wake rebuilds every channel, and
  // for the second or two before they re-sync, presence lists nobody — reading
  // that literally turned the whole friend list grey and back on every wake.
  const tracks = useRef<Map<string, PeerTrack>>(new Map());
  // Presence is pure socket state: after a wake, every channel below is
  // tracking against a connection that no longer exists, so both our own
  // status and the peers' are frozen at the moment of sleep until rebuilt.
  const { generation } = useConnection();

  // Stable primitive dep: re-subscribing on every array identity would tear
  // down and rebuild every channel each time the friends list refetches.
  const peerKey = useMemo(() => [...friendIds].sort().join(','), [friendIds]);

  useEffect(() => {
    const peers = peerKey ? peerKey.split(',') : [];
    // Forget anyone no longer a friend; their last-known status is not ours to
    // keep rendering.
    for (const id of tracks.current.keys()) {
      if (!peers.includes(id)) tracks.current.delete(id);
    }
    if (peers.length === 0) {
      tracks.current = new Map();
      setView({ tracks: tracks.current, now: Date.now() });
      return;
    }

    const channels: RealtimeChannel[] = [];

    const rebuild = () => {
      // Everyone presence currently lists, with every device they hold open.
      const present = new Map<string, PeerMeta[]>();
      for (const channel of channels) {
        const state = channel.presenceState<PeerMeta>();
        for (const [userId, metas] of Object.entries(state)) {
          if (userId === me) continue;
          const devices = present.get(userId);
          if (devices) devices.push(...metas);
          else present.set(userId, [...metas]);
        }
      }
      const now = Date.now();
      tracks.current = trackPeers(tracks.current, present, now);
      setView({ tracks: tracks.current, now });
    };

    const pushSelf = () => {
      const payload = { status: selfStatus(), updated_at: Date.now() };
      for (const channel of channels) channel.track(payload).catch(() => {});
    };

    for (const friendId of peers) {
      const channel = supabase.channel(`presence:${conversationKey(me, friendId)}`, {
        config: { presence: { key: me } },
      });
      channel
        .on('presence', { event: 'sync' }, rebuild)
        .on('presence', { event: 'join' }, rebuild)
        .on('presence', { event: 'leave' }, rebuild)
        .subscribe((status) => {
          // Fires again on every rejoin, which is what re-asserts us after a
          // channel drops: a rejoined channel carries none of its old state.
          if (status !== 'SUBSCRIBED') return;
          channel
            .track({ status: selfStatus(), updated_at: Date.now() })
            .catch(() => {});
        });
      channels.push(channel);
    }

    const unwatchActive = subscribeAppActive(pushSelf);

    // Heartbeat: re-assert our presence so peers keep seeing a fresh
    // `updated_at`; without this a peer would expire us via the staleness TTL.
    const heartbeat = window.setInterval(pushSelf, HEARTBEAT_MS);
    // Tick: advance the clock so stale peers flip to offline with no event.
    // Only runs while there are peers to expire — this value is in context, so
    // every tick re-renders the whole subtree.
    const tick = window.setInterval(
      () => setView({ tracks: tracks.current, now: Date.now() }),
      TICK_MS
    );

    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(tick);
      unwatchActive();
      for (const channel of channels) supabase.removeChannel(channel);
    };
  }, [me, peerKey, generation]);

  return <PresenceContext.Provider value={view}>{children}</PresenceContext.Provider>;
}

/** Live status for a single user id (defaults to offline). */
// react-refresh/only-export-components fires because this file exports a
// component (PresenceProvider) alongside a hook. The pairing is required by
// this hook's contract — it reads a context only that provider supplies — so
// it is suppressed rather than split, the same call `useToast.tsx` makes.
// eslint-disable-next-line react-refresh/only-export-components
export function usePresenceStatus(userId: string | null | undefined): PresenceStatus {
  const { tracks, now } = useContext(PresenceContext);
  if (!userId) return 'offline';
  const track = tracks.get(userId);
  if (!track) return 'offline';
  return resolveStatus(track, now);
}
