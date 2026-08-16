// What a presence dot is allowed to claim, and for how long.
//
// Supabase presence is a stream of diffs over a socket that dies whenever a
// phone sleeps, a channel rejoins, or the app wakes and rebuilds every
// subscription. Reading that stream literally means a peer blinks out of
// existence several times an hour while nothing has happened to them. The
// grades below turn a jittery stream into a claim worth rendering, and are kept
// here — pure and node-testable — rather than inside the provider.

/**
 * Presence status for a user:
 *   - 'active'     → app is open and in front (green)
 *   - 'background' → app is open but hidden or backgrounded (amber)
 *   - 'offline'    → not connected at all (grey)
 */
export type PresenceStatus = 'active' | 'background' | 'offline';

/** What a peer's device puts on the wire. */
export interface PeerMeta {
  status: Exclude<PresenceStatus, 'offline'>;
  updated_at: number;
}

/** What we keep about a peer between syncs. */
export interface PeerTrack {
  /** Strongest status across that peer's devices, as last reported. */
  status: Exclude<PresenceStatus, 'offline'>;
  /** The peer's newest own timestamp. Compared only against itself, to tell a
   *  fresh report from an entry Supabase is replaying, so their clock never
   *  has to agree with ours. */
  reported: number;
  /** Our clock, at the last time `reported` moved. */
  localAt: number;
  /** Our clock, at the moment the peer left every channel; null while present. */
  vanishedAt: number | null;
}

/** Silence this long means offline, whatever the socket still lists.
 *
 *  Sized against timer throttling, not against the heartbeat: browsers clamp
 *  intervals in hidden tabs to roughly one a minute, so a backgrounded peer
 *  beats at ~60s no matter how often it means to. This allows two missed
 *  throttled beats before the amber dot goes grey. */
export const STALE_MS = 150_000;

/** How long a peer may be missing from presence before we believe it.
 *
 *  A rejoin, a wake-driven rebuild or a single dropped frame removes everyone
 *  for a beat; rendering that is a grey flicker on a peer who never went
 *  anywhere. Long enough to cover a rebuild, short enough that a real
 *  disconnect still lands within a few seconds. */
export const VANISH_GRACE_MS = 12_000;

/** Merge one round of presence state into the tracked peers.
 *
 *  `present` is every peer currently listed across all channels, with each of
 *  their devices' metas. Peers absent from it are kept, stamped as vanished,
 *  until they are stale enough to be worth forgetting. */
export function trackPeers(
  prev: Map<string, PeerTrack>,
  present: Map<string, PeerMeta[]>,
  now: number
): Map<string, PeerTrack> {
  const next = new Map<string, PeerTrack>();

  for (const [userId, metas] of present) {
    if (metas.length === 0) continue;
    // Strongest signal across devices: one phone in front outranks three in a
    // pocket. Freshness is the newest stamp any of them sent.
    let status: Exclude<PresenceStatus, 'offline'> = 'background';
    let reported = 0;
    for (const meta of metas) {
      if (meta.status === 'active') status = 'active';
      if (meta.updated_at > reported) reported = meta.updated_at;
    }
    const before = prev.get(userId);
    const moved = !before || before.reported !== reported;
    next.set(userId, {
      status,
      reported,
      localAt: moved ? now : before.localAt,
      vanishedAt: null,
    });
  }

  for (const [userId, track] of prev) {
    if (next.has(userId)) continue;
    const vanishedAt = track.vanishedAt ?? now;
    // Past the stale window there is nothing left to say about them that
    // `resolveStatus` would not answer with 'offline' anyway.
    if (now - vanishedAt > STALE_MS) continue;
    next.set(userId, { ...track, vanishedAt });
  }

  return next;
}

/** What to render for a tracked peer at `now`. */
export function resolveStatus(track: PeerTrack, now: number): PresenceStatus {
  if (track.vanishedAt !== null && now - track.vanishedAt > VANISH_GRACE_MS) return 'offline';
  if (now - track.localAt > STALE_MS) return 'offline';
  return track.status;
}
