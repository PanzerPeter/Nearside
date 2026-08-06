import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module under test reaches for the realtime socket's health. Swap the
// whole client out: none of this needs (or should have) a network.
//
// `vi.hoisted`, not a plain const: `vi.mock` is hoisted above every import,
// and its factory runs while './connection' is being evaluated — which is
// before an ordinary top-level `const` here has initialised. The factory would
// close over a binding still in its temporal dead zone.
const socket = vi.hoisted(() => ({ connected: true }));
vi.mock('./supabase', () => ({
  supabase: {
    realtime: {
      isConnected: () => socket.connected,
      connect: () => {},
      disconnect: () => {},
    },
    auth: {
      getSession: async () => ({ data: { session: null } }),
      refreshSession: async () => ({ data: { session: null } }),
    },
  },
}));

import {
  forgetChannel,
  getConnectionState,
  reportChannelStatus,
  subscribeConnection,
} from './connection';

describe('connection health', () => {
  beforeEach(() => {
    socket.connected = true;
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
