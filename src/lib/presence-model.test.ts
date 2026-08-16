import { describe, expect, it } from 'vitest';
import {
  PeerTrack,
  STALE_MS,
  VANISH_GRACE_MS,
  resolveStatus,
  trackPeers,
} from './presence-model';

/** Shorthand for one channel sync: peer id → the metas that channel reported. */
function seen(entries: Record<string, { status: string; updated_at: number }[]>) {
  return new Map(Object.entries(entries)) as Map<
    string,
    { status: 'active' | 'background'; updated_at: number }[]
  >;
}

describe('trackPeers', () => {
  it('collapses a peer’s devices into the strongest status', () => {
    const next = trackPeers(
      new Map(),
      seen({ ann: [{ status: 'background', updated_at: 10 }, { status: 'active', updated_at: 5 }] }),
      1_000
    );
    expect(next.get('ann')?.status).toBe('active');
  });

  it('holds the freshness stamp on our clock while the peer’s stamp is unmoved', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    // Same reported timestamp a minute later: Supabase is replaying a stale
    // entry, not hearing from the peer. The stamp must not advance.
    const second = trackPeers(first, seen({ ann: [{ status: 'active', updated_at: 10 }] }), 61_000);
    expect(second.get('ann')?.localAt).toBe(1_000);
  });

  it('advances the freshness stamp when the peer’s own stamp moves', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    const second = trackPeers(first, seen({ ann: [{ status: 'active', updated_at: 11 }] }), 61_000);
    expect(second.get('ann')?.localAt).toBe(61_000);
  });

  it('is unaffected by a peer whose clock is wildly ahead', () => {
    // Their `updated_at` is an hour in our future; freshness is still ours.
    const first = trackPeers(
      new Map(),
      seen({ ann: [{ status: 'active', updated_at: 3_600_000 }] }),
      1_000
    );
    expect(first.get('ann')?.localAt).toBe(1_000);
    expect(resolveStatus(first.get('ann')!, 1_000)).toBe('active');
  });

  it('keeps a vanished peer with its last-known status, stamped as vanished', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    const second = trackPeers(first, seen({}), 2_000);
    expect(second.get('ann')?.status).toBe('active');
    expect(second.get('ann')?.vanishedAt).toBe(2_000);
  });

  it('does not re-stamp a peer that is still missing', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    const second = trackPeers(first, seen({}), 2_000);
    const third = trackPeers(second, seen({}), 9_000);
    expect(third.get('ann')?.vanishedAt).toBe(2_000);
  });

  it('clears the vanished stamp when the peer comes back', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    const gone = trackPeers(first, seen({}), 2_000);
    const back = trackPeers(gone, seen({ ann: [{ status: 'active', updated_at: 20 }] }), 3_000);
    expect(back.get('ann')?.vanishedAt).toBeNull();
  });

  it('forgets a peer that has been gone well past every grace', () => {
    const first = trackPeers(new Map(), seen({ ann: [{ status: 'active', updated_at: 10 }] }), 1_000);
    const gone = trackPeers(first, seen({}), 2_000);
    const later = trackPeers(gone, seen({}), 2_000 + STALE_MS + 1);
    expect(later.has('ann')).toBe(false);
  });
});

describe('resolveStatus', () => {
  const fresh: PeerTrack = {
    status: 'background',
    reported: 10,
    localAt: 1_000,
    vanishedAt: null,
  };

  it('reports the tracked status while the peer is fresh and present', () => {
    expect(resolveStatus(fresh, 1_500)).toBe('background');
  });

  it('reports offline once nothing has been heard for the stale window', () => {
    expect(resolveStatus(fresh, 1_000 + STALE_MS + 1)).toBe('offline');
  });

  it('holds the last-known status through a brief disappearance', () => {
    // A channel rebuild removes every peer for a beat. Greying the dot there
    // is the flicker this grace exists to stop.
    const vanished: PeerTrack = { ...fresh, status: 'active', vanishedAt: 2_000 };
    expect(resolveStatus(vanished, 2_000 + VANISH_GRACE_MS - 1)).toBe('active');
  });

  it('reports offline once a disappearance outlasts the grace', () => {
    const vanished: PeerTrack = { ...fresh, status: 'active', vanishedAt: 2_000 };
    expect(resolveStatus(vanished, 2_000 + VANISH_GRACE_MS + 1)).toBe('offline');
  });
});
