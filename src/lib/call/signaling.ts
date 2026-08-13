// Call signalling: sealed envelopes over Supabase Realtime broadcast.
//
// Nothing about a call is written down. Broadcast leaves no row, so the server
// relays bytes it cannot read and retains no record that a call happened, who
// placed it, or how long it lasted. That is the same posture the message path
// reaches by a longer route — 0023 dropped `messages.content` — and here it
// comes for free, so there is no `calls` table on purpose.
//
// **Why the ICE candidates are sealed and not just the SDP.** A candidate line
// carries the device's LAN address and, once the STUN reflexive candidate
// arrives, its public IP. Broadcasting those in clear would hand Supabase both
// peers' addresses on every call — precisely the class of data the rest of the
// app refuses to hold. So the discriminator, the SDP and the candidates all go
// inside the ciphertext, and only `callId` and `from` ride in clear, both of
// which the pair channel already implies.
//
// Sealing is `crypto_box` via `crypto/seal.ts` rather than `lib/sealed-body.ts`.
// That module is the *message* boundary: it branches on the self-chat and
// writes opened text through to the local mirror, neither of which applies to a
// signal that must never be persisted anywhere. The single-seal-boundary rule
// in CLAUDE.md is about message bodies; this is a different payload with a
// different lifetime.
//
// No Ed25519 signature, unlike `lib/rooms.ts`. Rooms need one because every
// member holds the same symmetric key, so decryption proves membership and not
// authorship. Here the seal is `crypto_box` between exactly two keypairs: a
// payload that opens with our private key and their public key could only have
// been sealed by someone holding their private key. Authorship is already
// established by the fact that it opened at all.

import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Identity } from '../crypto/keys';
import { openFrom, sealFor } from '../crypto/seal';
import { conversationKey } from '../conversation';
import { supabase } from '../supabase';
import { peerPublicKey } from '../peer-keys';
import { ENVELOPE_VERSION, isEnvelope, isSignal, type Envelope, type Signal } from './types';

/** One broadcast event carries every signal type; the type itself is sealed. */
const EVENT = 'signal';

/** Realtime topic for a pair. Same sorted-pair key presence uses, so the two
 *  halves of a conversation never disagree about which topic they are on. */
export function signalTopic(me: string, peerId: string): string {
  return `call:${conversationKey(me, peerId)}`;
}

export async function sealSignal(
  identity: Identity,
  peerPublic: Uint8Array,
  from: string,
  callId: string,
  signal: Signal
): Promise<Envelope> {
  const sealed = await sealFor(identity.boxPrivate, peerPublic, JSON.stringify(signal));
  return { v: ENVELOPE_VERSION, callId, from, ...sealed };
}

/**
 * The signal inside an envelope, or null.
 *
 * Null rather than a throw, for the same reason `verifyBytes` returns a
 * boolean: a broadcast topic is reachable by anyone who knows two user ids, so
 * garbage on it is a routine event on a hostile network rather than an
 * exception some call site will forget to catch. A forged payload fails the
 * Poly1305 tag and lands here as null, indistinguishable from noise, which is
 * what it should be.
 */
export async function openSignal(
  identity: Identity,
  peerPublic: Uint8Array,
  envelope: Envelope
): Promise<Signal | null> {
  try {
    const json = await openFrom(identity.boxPrivate, peerPublic, {
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
    });
    const parsed: unknown = JSON.parse(json);
    return isSignal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface IncomingSignal {
  peerId: string;
  callId: string;
  signal: Signal;
}

export interface SignalHub {
  /** True when the envelope reached the socket. False means the peer will
   *  never see it, which for an offer is the difference between a phone that
   *  rings and one that does not. */
  send(peerId: string, callId: string, signal: Signal): Promise<boolean>;
  /**
   * Change which peers are subscribed, keeping the topics that appear in both
   * sets untouched.
   *
   * The friend list arrives after the app starts, so the peer set always changes
   * at least once — and on the lock-screen path it changes *while a call is
   * being answered*, because the caller's topic was joined from the notification
   * before the list had loaded. Rebuilding the whole hub there drops the topic
   * carrying that call's candidates for as long as a rejoin takes.
   */
  setPeers(peerIds: string[]): void;
  close(): void;
}

interface HubOptions {
  me: string;
  identity: Identity;
  /** Accepted friends. One topic each — the same fanout presence already pays,
   *  and for the same reason: a single app-wide call topic would publish every
   *  account's ringing to everyone, and would grow with the user base rather
   *  than with your friends. */
  peerIds: string[];
  onSignal: (incoming: IncomingSignal) => void;
  /** A topic that has just gone live, including after a rejoin. Broadcast has no
   *  replay, so this is the first instant anything sent to that peer can arrive
   *  — see the `ready` signal. */
  onReady?: (peerId: string) => void;
}

/**
 * Joins one topic per friend and opens whatever arrives.
 *
 * Deliberately does not report channel health to `lib/connection.ts`. That
 * signal drives the "realtime is down, falling back to polling" banner over the
 * message thread, and a call topic hiccuping says nothing about whether
 * messages are being delivered. The call UI reports its own trouble.
 */
export function openSignalHub({
  me,
  identity,
  peerIds,
  onSignal,
  onReady,
}: HubOptions): SignalHub {
  const channels = new Map<string, RealtimeChannel>();
  const ready = new Set<string>();
  let closed = false;

  function join(peerId: string): void {
    if (peerId === me || channels.has(peerId)) return; // the self-chat has nobody to call
    const channel = supabase.channel(signalTopic(me, peerId), {
      config: { broadcast: { self: false } },
    });
    channel
      .on('broadcast', { event: EVENT }, ({ payload }) => {
        if (closed || !isEnvelope(payload)) return;
        // Our own echo, and anything claiming to be from a third party on a
        // two-person topic. Neither should reach the crypto.
        if (payload.from !== peerId) return;
        void (async () => {
          const peerPublic = await peerPublicKey(peerId);
          if (!peerPublic || closed) return;
          const signal = await openSignal(identity, peerPublic, payload);
          if (!signal || closed) return;
          onSignal({ peerId, callId: payload.callId, signal });
        })();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ready.add(peerId);
          if (!closed) onReady?.(peerId);
        } else {
          ready.delete(peerId);
        }
      });
    channels.set(peerId, channel);
  }

  function leave(peerId: string): void {
    const channel = channels.get(peerId);
    if (!channel) return;
    channels.delete(peerId);
    ready.delete(peerId);
    void supabase.removeChannel(channel);
  }

  for (const peerId of peerIds) join(peerId);

  return {
    async send(peerId, callId, signal) {
      const channel = channels.get(peerId);
      if (!channel) return false;
      const peerPublic = await peerPublicKey(peerId);
      // The same refusal `sealBody` makes. There is no plaintext path for a
      // signal either, so a peer with no published key simply cannot be called.
      if (!peerPublic) return false;
      const payload = await sealSignal(identity, peerPublic, me, callId, signal);
      try {
        const result = await channel.send({ type: 'broadcast', event: EVENT, payload });
        return result === 'ok';
      } catch {
        return false;
      }
    },
    setPeers(next) {
      if (closed) return;
      const wanted = new Set(next);
      for (const peerId of [...channels.keys()]) if (!wanted.has(peerId)) leave(peerId);
      for (const peerId of wanted) join(peerId);
    },
    close() {
      closed = true;
      ready.clear();
      for (const channel of channels.values()) supabase.removeChannel(channel);
      channels.clear();
    },
  };
}
