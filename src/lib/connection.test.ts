import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module under test reaches for the realtime socket's health. Swap the
// whole client out: none of this needs (or should have) a network.
//
// `vi.hoisted`, not a plain const: `vi.mock` is hoisted above every import,
// and its factory runs while './connection' is being evaluated — which is
// before an ordinary top-level `const` here has initialised. The factory would
// close over a binding still in its temporal dead zone.
const socket = vi.hoisted(() => ({ connected: true, connects: 0 }));
vi.mock('./supabase', () => ({
  supabase: {
    realtime: {
      isConnected: () => socket.connected,
      connect: () => {
        socket.connects += 1;
      },
      disconnect: () => {},
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      refreshSession: async () => ({ data: { session: null } }),
    },
  },
}));

import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  forgetChannel,
  getConnectionState,
  reportChannelStatus,
  subscribeConnection,
} from './connection';

describe('connection health', () => {
  beforeEach(() => {
    socket.connected = true;
    socket.connects = 0;
    // Leave the registry empty between cases; the module is a singleton.
    forgetChannel('a');
    forgetChannel('b');
  });

  it('reads as live with no channels registered yet', () => {
    expect(getConnectionState().live).toBe(true);
  });

  it('stays live while every registered channel is subscribed', () => {
    reportChannelStatus('a', 'SUBSCRIBED');
    reportChannelStatus('b', 'SUBSCRIBED');
    expect(getConnectionState().live).toBe(true);
  });

  it('degrades when any single channel errors, even with the socket up', () => {
    reportChannelStatus('a', 'SUBSCRIBED');
    reportChannelStatus('b', 'CHANNEL_ERROR');
    expect(getConnectionState().live).toBe(false);
  });

  it('degrades when the socket is down even if channels last reported fine', () => {
    reportChannelStatus('a', 'SUBSCRIBED');
    socket.connected = false;
    // Re-report to force a recompute, as a real status callback would.
    reportChannelStatus('a', 'SUBSCRIBED');
    expect(getConnectionState().live).toBe(false);
  });

  it('recovers once a broken channel is withdrawn', () => {
    reportChannelStatus('a', 'SUBSCRIBED');
    reportChannelStatus('b', 'TIMED_OUT');
    expect(getConnectionState().live).toBe(false);
    // A torn-down channel's last status must not pin the app to degraded —
    // `removeChannel` reports CLOSED, which would otherwise be permanent.
    forgetChannel('b');
    expect(getConnectionState().live).toBe(true);
  });

  it('notifies subscribers only when the state actually changes', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeConnection((s) => seen.push(s.live));

    reportChannelStatus('a', 'SUBSCRIBED'); // still live — no notification
    reportChannelStatus('a', 'CHANNEL_ERROR'); // live -> false
    reportChannelStatus('a', 'CHANNEL_ERROR'); // unchanged — no notification
    reportChannelStatus('a', 'SUBSCRIBED'); // false -> live

    unsubscribe();
    reportChannelStatus('a', 'CHANNEL_ERROR'); // unsubscribed — not seen

    expect(seen).toEqual([false, true]);
  });
});

// The app heals itself while degraded, so nothing has to ask the user to tap a
// retry button. Each case here is one the manual button used to cover.
describe('silent auto-heal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socket.connected = true;
    socket.connects = 0;
    forgetChannel('a');
  });

  afterEach(() => {
    // Leave the singleton healthy, so its retry timer is cancelled rather than
    // left ticking into the next test.
    socket.connected = true;
    forgetChannel('a');
    vi.useRealTimers();
  });

  it('reconnects on its own after a channel drops, with no user action', async () => {
    reportChannelStatus('a', 'CHANNEL_ERROR');
    expect(socket.connects).toBe(0);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    expect(socket.connects).toBe(1);
  });

  it('doubles the wait between attempts while it keeps failing', async () => {
    socket.connected = false; // reviving never restores health
    reportChannelStatus('a', 'CHANNEL_ERROR');

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    expect(socket.connects).toBe(1);
    // One base window is no longer enough for the second attempt.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(socket.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    expect(socket.connects).toBe(2);
  });

  it('never waits longer than the cap', async () => {
    socket.connected = false;
    reportChannelStatus('a', 'CHANNEL_ERROR');
    // Run the doubling well out past the cap. Uncapped, the wait would be
    // hours by the end of this and the window below would be silent.
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);

    const before = socket.connects;
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);
    expect(socket.connects).toBeGreaterThan(before);
    expect(socket.connects).toBeLessThanOrEqual(before + 2);
  });

  it('stops retrying once realtime is delivering again', async () => {
    reportChannelStatus('a', 'CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    expect(socket.connects).toBe(1);

    reportChannelStatus('a', 'SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
    expect(socket.connects).toBe(1);
  });

  it('starts the backoff over after a recovery', async () => {
    reportChannelStatus('a', 'CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    reportChannelStatus('a', 'SUBSCRIBED');

    reportChannelStatus('a', 'CHANNEL_ERROR');
    // Base delay again, not the doubled one the first outage had reached.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
    expect(socket.connects).toBe(2);
  });

  it('does not spin while the app is in the background', async () => {
    // A hidden tab or a backgrounded app has nobody looking at a stale
    // conversation, and reconnecting a socket the OS is about to freeze is
    // just battery. Coming back to the front is what resumes it.
    const doc = { visibilityState: 'hidden' };
    (globalThis as { document?: unknown }).document = doc;
    try {
      reportChannelStatus('a', 'CHANNEL_ERROR');
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
      expect(socket.connects).toBe(0);

      doc.visibilityState = 'visible';
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 1);
      expect(socket.connects).toBe(1);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
