import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from 'react';
import { Session, RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { conversationKey } from '../lib/conversation';
import { useConnection } from '../lib/connection';

/**
 * Presence status for a user:
 *   - 'active'     → app is open AND the tab/window is focused (green)
 *   - 'background' → app is open but hidden/blurred, e.g. another tab or the
 *                    installed PWA minimised (yellow)
 *   - 'offline'    → not connected at all (grey)
 */
export type PresenceStatus = 'active' | 'background' | 'offline';

interface PresenceState {
  status: PresenceStatus;
  updated_at: number;
}

// Re-broadcast our own status this often so peers' `updated_at` stays fresh
// even when no visibility/focus event fires.
const HEARTBEAT_MS = 25_000;
// If we haven't heard from a peer in this long, treat them as offline. A hard
// tab close or a frozen/throttled background tab may never emit a `leave` diff,
// so this TTL is what actually flips a silent peer to grey.
//
// Sized against timer throttling, not against HEARTBEAT_MS: browsers clamp
// setInterval in hidden tabs to roughly once per minute, so a backgrounded peer
// heartbeats at ~60s regardless of the constant above. A 70s TTL therefore sat
// inside one throttled beat plus network jitter, and the amber "Away" dot would
// flicker to grey and back. This allows two missed throttled beats.
const STALE_MS = 150_000;
// How often observers re-evaluate freshness so a peer expires without an event.
const TICK_MS = 15_000;

/** Live status + last-seen for every connected peer, plus a ticking clock. */
interface PresenceView {
  raw: Map<string, PresenceState>;
  now: number;
}

const PresenceContext = createContext<PresenceView>({ raw: new Map(), now: 0 });

/** Own status from the page's current visibility + focus. */
function selfStatus(): Exclude<PresenceStatus, 'offline'> {
  const visible =
    typeof document !== 'undefined' && document.visibilityState === 'visible';
  const focused = typeof document !== 'undefined' && document.hasFocus();
  return visible && focused ? 'active' : 'background';
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
  const [raw, setRaw] = useState<Map<string, PresenceState>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  // Presence is pure socket state: after a wake, every channel below is
  // tracking against a connection that no longer exists, so both our own
  // status and the peers' are frozen at the moment of sleep until rebuilt.
  const { generation } = useConnection();

  // Stable primitive dep: re-subscribing on every array identity would tear
  // down and rebuild every channel each time the friends list refetches.
  const peerKey = useMemo(() => [...friendIds].sort().join(','), [friendIds]);

  useEffect(() => {
    const peers = peerKey ? peerKey.split(',') : [];
    if (peers.length === 0) {
      setRaw(new Map());
      return;
    }

    // Per-peer freshness measured on OUR clock: the last local time that peer's
    // own reported timestamp actually advanced. Skew-proof, and it stops moving
    // the moment a peer goes silent (even if Supabase still lists them).
    const seen = new Map<string, { reported: number; localAt: number }>();
    const channels: RealtimeChannel[] = [];

    const rebuild = () => {
      const t = Date.now();
      const next = new Map<string, PresenceState>();
      const present = new Set<string>();

      for (const channel of channels) {
        const state = channel.presenceState<PresenceState>();
        for (const [userId, metas] of Object.entries(state)) {
          if (userId === me) continue;
          present.add(userId);
          // Collapse all of a user's devices into the strongest, freshest signal.
          let best: PresenceStatus = 'background';
          let reported = 0;
          for (const m of metas) {
            if (m.status === 'active') best = 'active';
            if (m.updated_at > reported) reported = m.updated_at;
          }
          // Refresh our local freshness stamp only when the peer's own timestamp
          // moved — a stale entry Supabase keeps around won't reset the TTL.
          const prev = seen.get(userId);
          const localAt = prev && prev.reported === reported ? prev.localAt : t;
          seen.set(userId, { reported, localAt });
          next.set(userId, { status: best, updated_at: localAt });
        }
      }

      // Drop bookkeeping for peers no longer present at all.
      for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
      setRaw(next);
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
          if (status !== 'SUBSCRIBED') return;
          channel
            .track({ status: selfStatus(), updated_at: Date.now() })
            .catch(() => {});
        });
      channels.push(channel);
    }

    document.addEventListener('visibilitychange', pushSelf);
    window.addEventListener('focus', pushSelf);
    window.addEventListener('blur', pushSelf);

    // Heartbeat: re-assert our presence so peers keep seeing a fresh
    // `updated_at`; without this a peer would expire us via the staleness TTL.
    const heartbeat = window.setInterval(pushSelf, HEARTBEAT_MS);
    // Tick: advance the clock so stale peers flip to offline with no event.
    // Only runs while there are peers to expire — this value is in context, so
    // every tick re-renders the whole subtree.
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);

    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', pushSelf);
      window.removeEventListener('focus', pushSelf);
      window.removeEventListener('blur', pushSelf);
      for (const channel of channels) supabase.removeChannel(channel);
    };
  }, [me, peerKey, generation]);

  const view = useMemo<PresenceView>(() => ({ raw, now }), [raw, now]);

  return <PresenceContext.Provider value={view}>{children}</PresenceContext.Provider>;
}

/** Live status for a single user id (defaults to offline). */
// react-refresh/only-export-components fires because this file exports a
// component (PresenceProvider) alongside a hook. The pairing is required by
// this hook's contract — it reads a context only that provider supplies — so
// it is suppressed rather than split, the same call `useToast.tsx` makes.
// eslint-disable-next-line react-refresh/only-export-components
export function usePresenceStatus(userId: string | null | undefined): PresenceStatus {
  const { raw, now } = useContext(PresenceContext);
  if (!userId) return 'offline';
  const entry = raw.get(userId);
  if (!entry) return 'offline';
  // A peer we haven't heard from within the TTL is treated as offline even if
  // their last diff never arrived (frozen tab, dropped socket, missed leave).
  if (now - entry.updated_at > STALE_MS) return 'offline';
  return entry.status;
}
