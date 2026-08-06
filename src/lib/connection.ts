// Connection lifecycle: waking the app back up, and telling the UI when the
// realtime stream is not actually carrying anything.
//
// The problem this exists to solve: after the machine sleeps (or a phone
// freezes the tab, or a VPN drops), the Supabase WebSocket is dead but nothing
// in the app notices. Channels never rejoin and no query is ever re-issued, so
// the app sits there showing a conversation frozen at the moment of sleep until
// the user reloads.
//
// Three signals feed "we just woke up":
//
//   1. `visibilitychange` → visible, and `pageshow` — the mobile/backgrounded
//      case, and bfcache restores.
//   2. `online` — the network came back.
//   3. A wall-clock jump between watchdog ticks. This is the one that matters
//      on desktop: sleeping a laptop with Nearside in the foreground fires *no*
//      visibility or focus event on wake, because as far as the page is
//      concerned it was visible and focused the whole time. Only the clock
//      gives it away.
//
// On any of them we refresh the auth token if it is close to expiry, kick the
// socket, and bump `generation`. Every subscriber keys its channel effect on
// that number, so a bump tears down and rebuilds every subscription and
// re-runs the fetches beside it — one mechanism, no per-hook wake logic.

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

/** How often the watchdog checks the wall clock. */
const WATCH_TICK_MS = 5_000;
/** A tick gap beyond this means time passed without us running — i.e. sleep.
 *  Comfortably above WATCH_TICK_MS so ordinary scheduler jitter never trips it. */
const SLEEP_GAP_MS = 20_000;
/** Coalesce the burst of events a single wake produces (online + visibility +
 *  clock jump all inside a second) into one revive. */
const RESUME_DEBOUNCE_MS = 400;
/** Floor between two revives, so a flapping network can't spin the app. */
const MIN_REVIVE_INTERVAL_MS = 3_000;
/** Refresh the access token on wake if it expires within this window — a
 *  token that dies mid-reconnect makes the socket rejoin and then get kicked. */
const TOKEN_REFRESH_MARGIN_MS = 120_000;

export interface ConnectionState {
  /** Bumped on every wake. Use as an effect dep to rebuild subscriptions. */
  generation: number;
  /** Whether realtime is believed to be delivering. False ⇒ fall back to polling. */
  live: boolean;
  /** Whether the device has a network at all. A degraded `live` with `online`
   *  still true is the socket being blocked, not the user being offline —
   *  two different things to tell someone. */
  online: boolean;
}

let state: ConnectionState = { generation: 0, live: true, online: true };
const listeners = new Set<(s: ConnectionState) => void>();

function publish(next: ConnectionState) {
  if (
    next.generation === state.generation &&
    next.live === state.live &&
    next.online === state.online
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener(state);
}

export function getConnectionState(): ConnectionState {
  return state;
}

export function subscribeConnection(listener: (s: ConnectionState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether the realtime socket reports itself connected. Feature-detected
 * rather than assumed: `isConnected` is realtime-js internals as far as the
 * public typings go, and an absent method must read as healthy rather than
 * permanently degrading every client.
 */
function socketConnected(): boolean {
  try {
    const rt = supabase.realtime as unknown as { isConnected?: () => boolean };
    return typeof rt.isConnected === 'function' ? rt.isConnected() : true;
  } catch {
    return true;
  }
}

// ---- Per-channel health ----------------------------------------------------
//
// The socket being up is necessary but not sufficient: a channel can be in
// CHANNEL_ERROR (RLS hiccup, server-side drop) while the socket happily
// heartbeats. Subscribers report their `subscribe()` status here so the UI can
// tell "connected" from "actually receiving".

const channelStatus = new Map<string, string>();

export function reportChannelStatus(key: string, status: string): void {
  channelStatus.set(key, status);
  recomputeLive();
}

export function forgetChannel(key: string): void {
  channelStatus.delete(key);
  recomputeLive();
}

function recomputeLive(): void {
  // `!== false`, not a truthiness test: an environment that exposes
  // `navigator` without implementing `onLine` yields undefined, and reading
  // that as "offline" would pin the app to degraded forever. Only an explicit
  // false counts as offline.
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const channelsOk = [...channelStatus.values()].every((s) => s === 'SUBSCRIBED');
  publish({ ...state, online, live: online && socketConnected() && channelsOk });
}

// ---- Wake handling ---------------------------------------------------------

let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let lastReviveAt = 0;

async function revive(): Promise<void> {
  lastReviveAt = Date.now();

  // 1. Token first. `getSession` alone can hand back a token that expired
  //    while the machine slept; refresh it before anything tries to use it.
  try {
    const { data } = await supabase.auth.getSession();
    const expiresAt = data.session?.expires_at;
    if (expiresAt && expiresAt * 1000 - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
      await supabase.auth.refreshSession();
    }
  } catch {
    /* offline, or no session — the channel rebuild below still runs */
  }

  // 2. Kick the socket. A half-open socket (our side thinks it's connected,
  //    the peer hung up during sleep) is the common post-wake state, so this
  //    disconnects explicitly rather than trusting `isConnected`.
  try {
    supabase.realtime.disconnect();
    supabase.realtime.connect();
  } catch {
    /* best effort */
  }

  // 3. Tell every subscriber to rebuild and refetch. Channel health is
  //    unknown until they re-report, so assume degraded until they do —
  //    that is what turns the polling fallback on during the gap.
  channelStatus.clear();
  publish({ ...state, generation: state.generation + 1, live: false });
}

function triggerResume(): void {
  if (resumeTimer) return;
  if (Date.now() - lastReviveAt < MIN_REVIVE_INTERVAL_MS) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    void revive();
  }, RESUME_DEBOUNCE_MS);
}

/** Manual retry, for the "Reconnect" affordance on the connection banner. */
export function pokeConnection(): void {
  lastReviveAt = 0;
  triggerResume();
}

let started = false;

/** Idempotent. Called from `main.tsx`; safe to call again. */
export function startConnectionMonitor(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    // Only a *visible* page can distinguish sleep from ordinary background
    // timer throttling — browsers clamp hidden-tab intervals to ~1/minute, so
    // a hidden tab would report a "sleep" every single tick. Hidden tabs get
    // their wake signal from `visibilitychange` instead, below.
    if (gap > SLEEP_GAP_MS && document.visibilityState === 'visible') {
      triggerResume();
      return;
    }
    recomputeLive();
  }, WATCH_TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') triggerResume();
  });
  window.addEventListener('online', () => {
    // Both: the flag flips back immediately, while the socket rebuild behind
    // `triggerResume` is debounced and takes a moment.
    recomputeLive();
    triggerResume();
  });
  window.addEventListener('offline', recomputeLive);
  window.addEventListener('pageshow', (e) => {
    // A bfcache restore hands back a page whose sockets were torn down.
    if ((e as PageTransitionEvent).persisted) triggerResume();
  });
}

/** Subscribe a component to `{ generation, live }`. */
export function useConnection(): ConnectionState {
  const [snapshot, setSnapshot] = useState<ConnectionState>(getConnectionState);
  useEffect(() => subscribeConnection(setSnapshot), []);
  return snapshot;
}
