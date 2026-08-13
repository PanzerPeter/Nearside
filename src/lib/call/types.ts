// The wire format for call signalling, and the shape of a call in progress.
//
// Everything a signal actually says travels inside `Envelope.ciphertext`. The
// clear fields are the two the receiving *client* needs before it can open
// anything: which call this belongs to, and whose key opens it. Both are
// already implied by the pair channel the envelope arrives on, so putting them
// in clear tells the relay nothing it could not derive.

/** Whether the camera is part of the call. Fixed when the offer is made:
 *  upgrading a voice call to video mid-flight means renegotiating tracks, and
 *  a half-finished renegotiation is a black screen with no way back. */
export type CallKind = 'voice' | 'video';

/** Which camera a video call is sending. Front to start with, because a call
 *  is a face; the back one is a deliberate act and the self-view stops being
 *  mirrored when it happens — a mirrored view of the room behind you is
 *  disorienting in a way a mirrored view of your own face is not. */
export type FacingMode = 'user' | 'environment';

/** The sealed payload. `t` is inside the ciphertext, not beside it — a relay
 *  that could read the discriminator would learn who declines whose calls. */
export type Signal =
  | { t: 'offer'; sdp: string; kind: CallKind }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: RTCIceCandidateInit }
  /**
   * "I am on the topic — offer now."
   *
   * Sent by a phone that was woken by the ring push and has only just joined
   * the pair topic. Broadcast has no replay, so everything the caller sent
   * before that moment is gone, and without this the answering side waits out
   * however much of the repeat interval is left. That wait is most of the delay
   * between tapping Answer on a locked phone and hearing the other person.
   */
  | { t: 'ready' }
  | { t: 'decline' }
  | { t: 'busy' }
  | { t: 'hangup' };

export const ENVELOPE_VERSION = 1;

export interface Envelope {
  v: number;
  /** Groups every signal of one call attempt. Redialling makes a new one, so a
   *  late candidate from an abandoned attempt cannot disturb the live call. */
  callId: string;
  /** Sender's user id. The pair channel has only two members, so this is a
   *  convenience for dropping our own echo rather than a routing necessity. */
  from: string;
  ciphertext: string;
  nonce: string;
}

/**
 * A broadcast payload is whatever the other end chose to send, and the other
 * end is not necessarily the app. Validate the shape before touching it: an
 * unchecked `payload.ciphertext` reaching libsodium is a crash in a hot path
 * that every friend can reach.
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === ENVELOPE_VERSION &&
    typeof e.callId === 'string' &&
    e.callId.length > 0 &&
    typeof e.from === 'string' &&
    e.from.length > 0 &&
    typeof e.ciphertext === 'string' &&
    typeof e.nonce === 'string'
  );
}

/**
 * Whether a decoded payload is a signal this build understands.
 *
 * Runs on plaintext that has already been authenticated by `crypto_box`, so
 * this is not a trust boundary — it is version tolerance. A future build
 * sending a signal type this one has never heard of should be ignored, not
 * treated as a protocol error that ends the call.
 */
export function isSignal(value: unknown): value is Signal {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  switch (s.t) {
    case 'offer':
      return typeof s.sdp === 'string' && (s.kind === 'voice' || s.kind === 'video');
    case 'answer':
      return typeof s.sdp === 'string';
    case 'ice':
      return typeof s.candidate === 'object' && s.candidate !== null;
    case 'ready':
    case 'decline':
    case 'busy':
    case 'hangup':
      return true;
    default:
      return false;
  }
}
