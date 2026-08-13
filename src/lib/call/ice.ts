// ICE servers for a call: where to find a path to the other phone.
//
// STUN alone gets two devices talking directly most of the time. It does not
// when either end is behind symmetric NAT or carrier-grade NAT, which on mobile
// networks is common rather than exotic — and this is a mobile app. TURN is the
// relay for those calls, and without it they simply never connect.
//
// A TURN relay forwards SRTP it cannot decrypt: the media keys come out of the
// DTLS handshake between the two devices and never reach it. So the relay costs
// no confidentiality. What it does see is that two addresses exchanged packets,
// which is why the credentials are minted per call with a short life and why
// the transparency screen names the provider.
//
// The credentials themselves are minted by the `call-ice` edge function, not
// held in the bundle. A long-lived TURN secret shipped inside an APK is a free
// relay for anyone who unzips it.

import { supabase } from '../supabase';

/**
 * Used when `call-ice` cannot be reached at all.
 *
 * One provider, not a list. Adding a second STUN host from a different company
 * would mean a call setup told two organisations that this device is placing a
 * call, to buy redundancy on the step that is least likely to fail. The same
 * provider that supplies TURN supplies this, so a call involves exactly one
 * third party or none.
 */
const STUN_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Re-mint this long before expiry, so a call placed at the edge of the window
 *  does not start with credentials that die during ICE gathering. */
const REFRESH_MARGIN_MS = 60_000;
/** Cap on what a server-supplied TTL can claim, so a bad response cannot pin
 *  stale credentials in the cache for the life of the process. */
const MAX_TTL_MS = 12 * 60 * 60 * 1000;

export interface IceBundle {
  servers: RTCIceServer[];
  expiresAt: number;
}

let cache: IceBundle | null = null;

/**
 * Coerce whatever the provider returned into the array `RTCPeerConnection`
 * wants.
 *
 * Cloudflare answers with an `iceServers` array holding one entry, which bundles
 * the STUN url and the three TURN transports under a single username and
 * credential; other providers answer with a bare object, or with one entry per
 * url. All three shapes land here. A mismatch is not a type error at build time
 * — it is a peer connection constructed with no usable servers, which looks
 * exactly like a network problem at 3am. Anything without a `urls` is dropped
 * rather than passed on.
 */
export function normalizeIceServers(raw: unknown): RTCIceServer[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const servers: RTCIceServer[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const urls = record.urls;
    const usable =
      typeof urls === 'string'
        ? urls.length > 0
        : Array.isArray(urls) && urls.some((u) => typeof u === 'string' && u.length > 0);
    if (!usable) continue;
    const server: RTCIceServer = { urls: urls as string | string[] };
    if (typeof record.username === 'string') server.username = record.username;
    if (typeof record.credential === 'string') server.credential = record.credential;
    servers.push(server);
  }
  return servers;
}

/** Seconds the response says the credentials last, clamped to something sane.
 *  A missing or absurd value falls back to an hour. */
export function ttlToExpiry(ttlSeconds: unknown, now: number): number {
  const seconds = typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) ? ttlSeconds : 3600;
  const ms = Math.min(Math.max(seconds, 60) * 1000, MAX_TTL_MS);
  return now + ms;
}

export function isFresh(bundle: IceBundle | null, now: number): boolean {
  return bundle !== null && bundle.expiresAt - now > REFRESH_MARGIN_MS;
}

/**
 * ICE servers for a new peer connection.
 *
 * Never rejects. A call that has to run on STUN alone is worse than one with a
 * relay behind it, but it is far better than a call button that throws — most
 * calls do connect peer-to-peer, and the ones that do not will fail visibly a
 * few seconds later with a reason the UI can show.
 */
export async function iceServers(now: number = Date.now()): Promise<RTCIceServer[]> {
  if (isFresh(cache, now)) return cache!.servers;
  try {
    const { data, error } = await supabase.functions.invoke('call-ice');
    if (error || !data) return STUN_FALLBACK;
    const payload = data as { iceServers?: unknown; ttl?: unknown };
    const servers = normalizeIceServers(payload.iceServers);
    if (servers.length === 0) return STUN_FALLBACK;
    cache = { servers, expiresAt: ttlToExpiry(payload.ttl, now) };
    return servers;
  } catch {
    return STUN_FALLBACK;
  }
}

/**
 * Drop the cached credentials.
 *
 * Called on sign-out with every other per-account cache (see `App.signOut`).
 * These are minted against the signed-in user's JWT, and leaving them for the
 * next account on the phone would have that account's calls relayed under the
 * previous owner's credentials.
 */
export function forgetIceServers(): void {
  cache = null;
}
