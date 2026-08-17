// The call state machine, as a pure reducer.
//
// A call is a small amount of state that four things change at once — the local
// user, the remote user, the peer connection, and a ring timeout — and getting
// their interleavings wrong shows up as a phone that rings after the caller
// hung up, or a "call ended" screen over a live call. Keeping the transitions
// here, with no WebRTC or React in reach, is what makes those interleavings
// testable in the node suite this repo runs.

import type { CallKind, FacingMode } from './types';

export type CallPhase =
  /** Nothing happening. The only phase with no peer. */
  | 'idle'
  /** We placed the call; their phone may not have rung yet. */
  | 'dialing'
  /** They placed the call and we have not answered. */
  | 'ringing'
  /** Answered on both sides, media not flowing yet. */
  | 'connecting'
  /** Media is flowing. */
  | 'active'
  /** Over, and the reason is worth showing for a moment before it clears. */
  | 'ended';

export type EndReason =
  | 'hungup'
  | 'remote-hungup'
  | 'declined'
  | 'remote-declined'
  | 'unanswered'
  | 'busy'
  | 'failed'
  /** The peer has published no public key, so nothing could be sealed to them.
   *  The same refusal `sealBody` makes, for the same reason. */
  | 'no-key'
  /** Their key is not the one we recorded. Never dialled, never answered. */
  | 'key-changed';

export interface CallState {
  phase: CallPhase;
  callId: string | null;
  peerId: string | null;
  /** What to call them on the call screen: nickname if set, handle otherwise.
   *  Carried in state because the call outlives the conversation view that
   *  knows it. */
  peerName: string;
  kind: CallKind;
  /** Whether we placed this call. Decides who offers, and what the ended
   *  screen says. */
  outgoing: boolean;
  reason: EndReason | null;
  /** Wall clock when media connected, for the duration readout. Null until
   *  then, so a call that never connected reports no duration rather than
   *  zero seconds of one. */
  connectedAt: number | null;
  muted: boolean;
  cameraOff: boolean;
  /** Which camera is being sent. Held here because the self-view is mirrored
   *  for the front one and must not be for the back one. */
  facing: FacingMode;
  speaker: boolean;
  /** Whether a remote video track has actually arrived. A video call whose
   *  peer denied the camera still has to render something. */
  remoteVideo: boolean;
}

export const idleCall: CallState = {
  phase: 'idle',
  callId: null,
  peerId: null,
  peerName: '',
  kind: 'voice',
  outgoing: false,
  reason: null,
  connectedAt: null,
  muted: false,
  cameraOff: false,
  facing: 'user',
  speaker: false,
  remoteVideo: false,
};

export type CallEvent =
  | { type: 'dial'; callId: string; peerId: string; peerName: string; kind: CallKind }
  | { type: 'incoming'; callId: string; peerId: string; peerName: string; kind: CallKind }
  /**
   * Answered on the lock screen, before the offer for it has reached this
   * device — the app is starting up because of that tap. There is nothing to
   * decide any more, so the call goes straight to `connecting` rather than
   * showing an Answer button for a call that has already been answered.
   */
  | { type: 'answering'; callId: string; peerId: string; peerName: string; kind: CallKind }
  /** We tapped answer. */
  | { type: 'accept' }
  /** Their answer SDP arrived, so they tapped answer. */
  | { type: 'answered' }
  | { type: 'connected'; at: number }
  | { type: 'end'; reason: EndReason }
  | { type: 'mute'; on: boolean }
  | { type: 'camera'; off: boolean }
  /** Reported by the session once the swap actually happened. A phone with one
   *  camera reports the one it already had. */
  | { type: 'facing'; facing: FacingMode }
  | { type: 'speaker'; on: boolean }
  | { type: 'remote-video'; on: boolean }
  /** The display name the ring did not wait for. Carries its call id because it
   *  arrives from a query the ring deliberately does not block on. */
  | { type: 'peer-name'; callId: string; peerName: string }
  /** Clear the ended screen back to idle. */
  | { type: 'dismiss' };

/**
 * A video call starts on the speaker and a voice call starts on the earpiece.
 *
 * Not a preference: on a video call the phone is at arm's length, and routing
 * that to the earpiece makes it inaudible. On a voice call the phone is against
 * an ear, and routing that to the speaker puts the conversation in the room.
 */
export function defaultSpeaker(kind: CallKind): boolean {
  return kind === 'video';
}

/** Phases in which a second call must not be started or accepted. `ended` is
 *  excluded deliberately — it is a screen, not a call, and someone should be
 *  able to ring straight back from it. */
export function isEngaged(state: CallState): boolean {
  return state.phase !== 'idle' && state.phase !== 'ended';
}

/**
 * Which side backs down when both people dial each other at the same instant.
 *
 * Lexicographic on user id: both devices compute the same answer from data they
 * already have, with no extra round trip to a server that is deliberately not
 * in this path. The polite peer abandons its own outgoing call and answers
 * theirs; the impolite one ignores the incoming offer and keeps dialling. Any
 * total order would do — this one is just the one both ends can agree on.
 */
export function isPolite(me: string, peerId: string): boolean {
  return me < peerId;
}

export function callReducer(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case 'dial':
      return {
        ...idleCall,
        phase: 'dialing',
        callId: event.callId,
        peerId: event.peerId,
        peerName: event.peerName,
        kind: event.kind,
        outgoing: true,
        speaker: defaultSpeaker(event.kind),
      };

    case 'incoming':
      // Replaces whatever was there, including our own outgoing attempt: the
      // provider only sends this after `isPolite` says we are the side that
      // yields. Arriving in any other phase is a bug in the caller, not
      // something to paper over here.
      return {
        ...idleCall,
        phase: 'ringing',
        callId: event.callId,
        peerId: event.peerId,
        peerName: event.peerName,
        kind: event.kind,
        outgoing: false,
        speaker: defaultSpeaker(event.kind),
      };

    case 'answering':
      // Only out of a standing start. A call already on this screen — one being
      // rung, or one in progress — must not be replaced by a notification tap
      // for something else, and the ring path handles that case anyway.
      if (state.phase !== 'idle' && state.phase !== 'ended') return state;
      return {
        ...idleCall,
        phase: 'connecting',
        callId: event.callId,
        peerId: event.peerId,
        peerName: event.peerName,
        kind: event.kind,
        outgoing: false,
        speaker: defaultSpeaker(event.kind),
      };

    case 'accept':
      // `connecting` already: answered from the lock screen before the offer
      // arrived. Idempotent rather than ignored, so the ring that follows can
      // accept without checking how it got here.
      if (state.phase === 'connecting') return state;
      if (state.phase !== 'ringing') return state;
      return { ...state, phase: 'connecting' };

    case 'answered':
      // Only meaningful for the side that dialled. A stray answer against a
      // call we did not place would otherwise jump us into `connecting` with no
      // peer connection behind it.
      if (state.phase !== 'dialing') return state;
      return { ...state, phase: 'connecting' };

    case 'connected':
      if (state.phase !== 'connecting' && state.phase !== 'dialing') return state;
      // An ICE restart mid-call re-fires this. Keep the original stamp, or the
      // duration readout resets to zero every time the network wobbles.
      return {
        ...state,
        phase: 'active',
        connectedAt: state.connectedAt ?? event.at,
      };

    case 'end':
      // Idle has nothing to end. Without this guard a late hangup for a call
      // that already cleared would raise an "ended" screen out of nowhere.
      if (state.phase === 'idle') return state;
      // First reason wins. Hanging up locally sends a hangup, which the peer
      // answers in kind; letting the echo overwrite would relabel every call
      // you ended as one they ended.
      if (state.phase === 'ended') return state;
      return { ...state, phase: 'ended', reason: event.reason };

    case 'mute':
      return { ...state, muted: event.on };

    case 'camera':
      return { ...state, cameraOff: event.off };

    case 'facing':
      return { ...state, facing: event.facing };

    case 'speaker':
      return { ...state, speaker: event.on };

    case 'remote-video':
      return { ...state, remoteVideo: event.on };

    case 'peer-name':
      // Only for the call that asked. A slow lookup that lands after the call
      // it belonged to ended would otherwise put a stranger's name on the next
      // one.
      if (state.callId !== event.callId || !event.peerName) return state;
      return { ...state, peerName: event.peerName };

    case 'dismiss':
      if (state.phase !== 'ended') return state;
      return idleCall;
  }
}

/** Seconds of connected media, or null for a call that never connected. */
export function callDuration(state: CallState, now: number): number | null {
  if (state.connectedAt === null) return null;
  return Math.max(0, Math.floor((now - state.connectedAt) / 1000));
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** What the ended screen says. Phrased from the point of view of the person
 *  reading it, which is why the same wire event reads differently on each end. */
export function endLabel(state: CallState): string {
  switch (state.reason) {
    case 'hungup':
    case 'remote-hungup':
      // A call that never connected was not "ended" by anyone in a way worth
      // reporting — from the caller's side it was cancelled, from the
      // receiver's it was missed.
      if (state.connectedAt !== null) return 'Call ended';
      return state.outgoing ? 'Call cancelled' : 'Missed call';
    case 'declined':
      return 'Declined';
    case 'remote-declined':
      return 'Call declined';
    case 'unanswered':
      return state.outgoing ? 'No answer' : 'Missed call';
    case 'busy':
      return 'On another call';
    case 'failed':
      return 'Could not connect';
    case 'no-key':
      return 'They have no encryption key yet';
    case 'key-changed':
      return 'Their key changed. Verify before calling';
    default:
      return 'Call ended';
  }
}
