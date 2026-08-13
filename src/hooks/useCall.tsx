// The call hub: one place that owns the state machine, the signalling hub, the
// peer connection and the native side, for the whole app.
//
// A provider rather than something inside `ChatRoom`, because a call outlives
// the conversation that started it — the user can go back to the list, open
// another chat, or answer from a notification with no chat open at all. It sits
// beside `PresenceProvider` for the same reason.
//
// **The peer connection is deliberately outside the generation effect.** Every
// realtime subscriber in this app rebuilds when `lib/connection.ts` bumps
// `generation`, and the signalling hub below does too. The `CallSession` does
// not: its media is peer-to-peer and is alive whether or not the Supabase
// socket is. Keying it on the generation would drop every call the moment a
// phone's screen came back on.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Identity } from '../lib/crypto/keys';
import { toBase64 } from '../lib/crypto/keys';
import { supabase } from '../lib/supabase';
import { useConnection } from '../lib/connection';
import { peerPublicKey } from '../lib/peer-keys';
import { verificationState } from '../lib/verification';
import { nicknameFor } from '../lib/nicknames';
import { tapWarning } from '../lib/haptics';
import { iceServers } from '../lib/call/ice';
import { openSignalHub, type SignalHub } from '../lib/call/signaling';
import { CallSession, mediaConstraints } from '../lib/call/session';
import {
  callReducer,
  idleCall,
  isEngaged,
  isPolite,
  type CallState,
} from '../lib/call/state';
import { routeOffer } from '../lib/call/routing';
import type { CallKind, Signal } from '../lib/call/types';
import { startRingback, startRingtone, stopRinging } from '../lib/call/ringtone';
import {
  consumePendingCall,
  dismissNativeIncoming,
  endNativeCall,
  onNativeCallAction,
  setNativeSpeaker,
  showNativeIncoming,
  startNativeCall,
  type PendingCall,
} from '../lib/call/native';
import {
  holdWarmMedia,
  primeMedia,
  releaseWarmMedia,
  takeWarmMedia,
} from '../lib/call/warmup';

/** How long a phone rings before the call gives up. Matches what a mobile
 *  network does closely enough that neither end is left wondering. */
const RING_TIMEOUT_MS = 45_000;
/**
 * How long both sides have answered but no media is flowing before the call is
 * called off.
 *
 * Without this a call that is answered and then cannot find a path sits on
 * "Connecting…" forever: `RTCPeerConnection` reaches `failed` on its own for a
 * path that breaks, but a peer that never gathers a usable candidate at all can
 * leave it in `connecting` indefinitely, and nothing else here is watching.
 */
const CONNECT_TIMEOUT_MS = 45_000;
/**
 * How often the dialling side re-broadcasts its offer.
 *
 * The offer is relayed to whoever is subscribed at that instant and then gone.
 * A phone woken from a killed process by the ring push joins the topic seconds
 * later, so a single broadcast is one it can only miss — repeating is what
 * makes a call to a locked, pocketed phone connect at all.
 */
const OFFER_REPEAT_MS = 2_000;
/**
 * The same, for the opening seconds.
 *
 * That window is when the far phone is booting from the push, and every repeat
 * it misses is dead air between someone tapping Answer and hearing a voice. The
 * `ready` signal usually beats this to it and asks for an offer directly; this
 * is what covers the case where that one broadcast is the one that gets lost.
 */
const OFFER_REPEAT_FAST_MS = 700;
/** How long the fast repeats last. Past this the far end has either joined or
 *  is not going to, and a repeat every two seconds is enough to catch it. */
const OFFER_FAST_WINDOW_MS = 8_000;
/** How long the ended screen stays before clearing itself. */
const ENDED_LINGER_MS = 4_000;
/** How long a call answered on the lock screen waits for the offer it was
 *  answered before. Long enough for a cold start on a slow phone, short enough
 *  that a caller who gave up in the meantime does not leave someone watching
 *  "Connecting…" for the length of a full ring. */
const ANSWER_WAIT_MS = 20_000;

export interface CallApi {
  state: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Whether calling is possible at all here — false in a browser, where there
   *  is no foreground service and no ring. */
  placeCall: (peer: { id: string; display_name: string }, kind: CallKind) => void;
  accept: () => void;
  decline: () => void;
  hangup: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  /** Front camera to back and back again. A no-op on a phone with one. */
  flipCamera: () => void;
  toggleSpeaker: () => void;
  dismiss: () => void;
}

const noop = () => {};

const CallContext = createContext<CallApi>({
  state: idleCall,
  localStream: null,
  remoteStream: null,
  placeCall: noop,
  accept: noop,
  decline: noop,
  hangup: noop,
  toggleMute: noop,
  toggleCamera: noop,
  flipCamera: noop,
  toggleSpeaker: noop,
  dismiss: noop,
});

/** An offer that arrived and is waiting for the user to answer it. Held out of
 *  React state because it is not rendered — only the ring is. */
interface PendingOffer {
  callId: string;
  peerId: string;
  sdp: string;
  kind: CallKind;
}

export function CallProvider({
  session,
  identity,
  friendIds,
  children,
}: {
  session: Session;
  identity: Identity;
  /** Accepted friends. One signalling topic each, like presence. */
  friendIds: string[];
  children: ReactNode;
}) {
  const me = session.user.id;
  const { generation } = useConnection();
  const [state, dispatch] = useReducer(callReducer, idleCall);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const hubRef = useRef<SignalHub | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const offerRef = useRef<PendingOffer | null>(null);
  /** Candidates for a ringing call, which has no peer connection yet. The far
   *  end starts gathering the moment it offers, so these arrive while the phone
   *  is still ringing and would otherwise be lost. */
  const earlyCandidates = useRef<RTCIceCandidateInit[]>([]);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A decision taken before the call it belongs to arrived — see `accept`. */
  const armed = useRef<{ callId: string; action: 'accept' | 'decline' } | null>(null);
  /**
   * A call this device knows is coming and has no offer for: a ring answered or
   * opened on the lock screen of a phone whose app the system had killed.
   *
   * Its peer is the one topic that has to be joined before anything else — the
   * friend list has not loaded yet, so without this the app subscribes to
   * nothing and the offer it is waiting for is broadcast to an empty room.
   */
  const awaited = useRef<{ callId: string; peerId: string } | null>(null);
  /** The peer behind `awaited`, in state because it changes which topics the
   *  hub holds. */
  const [wakePeer, setWakePeer] = useState<string | null>(null);

  // Read inside callbacks that must stay stable. A callback closing over
  // `state` would be rebuilt on every tick of the duration timer, and the
  // signalling hub keyed on it would tear down mid-call.
  const stateRef = useRef(state);
  stateRef.current = state;

  const sendSignal = useCallback((peerId: string, callId: string, signal: Signal) => {
    void hubRef.current?.send(peerId, callId, signal);
  }, []);

  /** Everything a finished call has to let go of. Idempotent. */
  const teardown = useCallback(() => {
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    const done = offerRef.current?.callId ?? stateRef.current.callId ?? undefined;
    offerRef.current = null;
    earlyCandidates.current = [];
    // A decision that was never claimed by a ring. Left in place it would fire
    // against some later call that happens to reach `ringing` first.
    armed.current = null;
    awaited.current = null;
    // A microphone opened for a call that was answered and then never arrived —
    // the caller gave up while this phone was still starting. Nothing else will
    // claim it, and Android goes on showing the recording indicator until it is
    // given back.
    releaseWarmMedia();
    setLocalStream(null);
    setRemoteStream(null);
    stopRinging();
    // Named, so the native side can refuse to ring for this call again when the
    // push arrives after the realtime offer has already been dealt with.
    void dismissNativeIncoming(done);
    void endNativeCall();
  }, []);

  /** Build a session bound to the call currently in state. */
  const makeSession = useCallback(
    async (peerId: string, callId: string, kind: CallKind) => {
      const servers = await iceServers();
      const call = new CallSession({
        createPeer: (config) => new RTCPeerConnection(config),
        getMedia: async (constraints) => {
          // The opening capture only. `flipCamera` asks for a camera on its own
          // and must never be handed the stream the call is already using.
          if (constraints.audio) {
            const warm = takeWarmMedia(kind);
            if (warm) {
              try {
                return await warm;
              } catch {
                // The primed capture was refused — a permission dialog answered
                // after it started, usually. Ask again rather than fail the call.
              }
            }
          }
          return navigator.mediaDevices.getUserMedia(constraints);
        },
        send: (signal) => sendSignal(peerId, callId, signal),
        onRemoteStream: (stream) => {
          setRemoteStream(stream);
          dispatch({ type: 'remote-video', on: stream.getVideoTracks().length > 0 });
        },
        onLocalStream: setLocalStream,
        onConnected: () => dispatch({ type: 'connected', at: Date.now() }),
        onFailed: () => dispatch({ type: 'end', reason: 'failed' }),
        iceServers: servers,
        kind,
        polite: isPolite(me, peerId),
      });
      sessionRef.current = call;
      return call;
    },
    [me, sendSignal]
  );

  // ---- outgoing -----------------------------------------------------------

  const placeCall = useCallback(
    (peer: { id: string; display_name: string }, kind: CallKind) => {
      if (isEngaged(stateRef.current)) return;
      const callId = crypto.randomUUID();
      const peerName = nicknameFor(peer.id) ?? `@${peer.display_name}`;
      dispatch({ type: 'dial', callId, peerId: peer.id, peerName, kind });

      void (async () => {
        // The same two refusals the message path makes, before anything rings.
        // Calling someone whose key we cannot verify is exactly the moment not
        // to be quiet about it.
        const key = await peerPublicKey(peer.id);
        if (!key) {
          dispatch({ type: 'end', reason: 'no-key' });
          return;
        }
        if ((await verificationState(peer.id, await toBase64(key))) === 'changed') {
          void tapWarning();
          dispatch({ type: 'end', reason: 'key-changed' });
          return;
        }
        if (stateRef.current.callId !== callId) return;

        // Capture before anything else, because it is the one step the user can
        // refuse — nobody's phone should ring for a call a denied microphone is
        // about to end.
        let capture: MediaStream;
        try {
          capture = await navigator.mediaDevices.getUserMedia(mediaConstraints(kind));
        } catch {
          dispatch({ type: 'end', reason: 'failed' });
          return;
        }
        holdWarmMedia(kind, capture);
        // Cancelled while the permission dialog was up. The teardown that ran
        // for it found nothing to release, so this releases it.
        if (stateRef.current.callId !== callId) {
          releaseWarmMedia();
          return;
        }

        // Wake their phone *now*, not after the credentials and the offer: the
        // push goes through Google's servers and the phone it reaches may have
        // to start the app from nothing, so it is the longest pole in the call
        // and every step it overlaps is a step off the front of it. A friend
        // with the app open rings from the offer alone and never needs this.
        void supabase.functions
          .invoke('call-ring', { body: { peer_id: peer.id, call_id: callId, kind } })
          .catch(() => {});

        try {
          // Claims the capture above rather than opening a second one.
          const call = await makeSession(peer.id, callId, kind);
          await call.startOutgoing();
          setLocalStream(call.localStream);
        } catch {
          dispatch({ type: 'end', reason: 'failed' });
        }
      })();
    },
    [makeSession]
  );

  // ---- incoming -----------------------------------------------------------

  /** Build the connection and send the answer. Everything past the decision. */
  const answer = useCallback(
    (offer: PendingOffer) => {
      dispatch({ type: 'accept' });
      armed.current = null;
      awaited.current = null;
      void dismissNativeIncoming(offer.callId);
      void (async () => {
        try {
          const call = await makeSession(offer.peerId, offer.callId, offer.kind);
          await call.acceptIncoming(offer.sdp);
          setLocalStream(call.localStream);
          // Candidates that arrived while the phone was ringing. Without these
          // the direct path is often never found and the call falls to the relay.
          for (const candidate of earlyCandidates.current) {
            await call.handle({ t: 'ice', candidate });
          }
          earlyCandidates.current = [];
        } catch {
          dispatch({ type: 'end', reason: 'failed' });
        }
      })();
    },
    [makeSession]
  );

  /**
   * Start ringing, now.
   *
   * Nothing here waits on the network. A nickname is already in memory, and the
   * profile lookup behind an unfamiliar caller is a request over the same link
   * that has just woken a locked phone — putting it in front of the ring meant
   * a ring that arrived seconds late, or on a phone that had gone back to sleep
   * before the query returned, not at all. The name catches up on its own.
   *
   * An offer for a call that was *already answered* on the lock screen passes
   * through here too, and must not ring: no notification, no ringtone, and no
   * Answer button for a call the user has picked up. It is answered on the spot
   * instead, in the same batch as the state that carries it, so the screen never
   * shows the ring at all.
   */
  const ring = useCallback(
    (offer: PendingOffer) => {
      offerRef.current = offer;
      earlyCandidates.current = [];
      const answered = armed.current?.callId === offer.callId && armed.current.action === 'accept';
      const nick = nicknameFor(offer.peerId);
      const shown = {
        callId: offer.callId,
        peerId: offer.peerId,
        peerName: nick ?? 'Someone',
        kind: offer.kind,
      };
      // A call answered from a notification is already in state, under this
      // name. Dispatching over it would take it back to `ringing` for a frame
      // and lose a display name that has since been looked up.
      const standing =
        stateRef.current.callId === offer.callId && stateRef.current.phase === 'connecting';
      if (!standing) dispatch({ type: 'incoming', ...shown });
      if (answered) answer(offer);
      else void showNativeIncoming(shown);
      if (nick) return;

      void (async () => {
        // The friend list may not be loaded at all — a push can wake the app
        // straight into a ring.
        const { data } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', offer.peerId)
          .maybeSingle();
        if (!data?.display_name || offerRef.current?.callId !== offer.callId) return;
        const peerName = `@${data.display_name}`;
        dispatch({ type: 'peer-name', callId: offer.callId, peerName });
        // Corrects the notification in place. Re-posting the same id is silent —
        // `setOnlyAlertOnce` — so the ringtone is not restarted by a name. Not
        // re-posted at all for a call already answered: there is no ring left to
        // correct, and posting one would raise it again.
        if (!answered) void showNativeIncoming({ ...shown, peerName });
      })();
    },
    [answer]
  );

  /**
   * Answer, or remember to answer.
   *
   * A ring answered on the lock screen of a phone whose app was killed arrives
   * here *before* the offer does: the push woke the process, and the offer is on
   * a broadcast topic this device has only just joined. Dropping the decision
   * there is what made those calls fail silently. Arming it instead costs
   * nothing — `ring` answers the moment the offer lands, and `prepareForCall`
   * has spent the wait asking for that offer and opening the microphone.
   */
  const accept = useCallback(
    (callId?: string) => {
      const current = stateRef.current;
      const offer = offerRef.current;
      // A call id that names some other call is a stale notification — the ring
      // for a call that has since ended, tapped late. Answering the call actually
      // on screen instead would answer the wrong person.
      const wrongCall = callId !== undefined && offer?.callId !== callId;
      if (current.phase !== 'ringing' || !offer || wrongCall) {
        if (callId) armed.current = { callId, action: 'accept' };
        return;
      }
      answer(offer);
    },
    [answer]
  );

  /** Refuse, or remember to refuse. Armed for the same reason as `accept`, and
   *  with a better outcome than the alternative: a decline the caller never
   *  hears leaves them listening to a ring for the full timeout. */
  const decline = useCallback(
    (callId?: string) => {
      const current = stateRef.current;
      const wrongCall = callId !== undefined && current.callId !== callId;
      if (current.phase !== 'ringing' || !current.peerId || !current.callId || wrongCall) {
        if (callId) armed.current = { callId, action: 'decline' };
        return;
      }
      sendSignal(current.peerId, current.callId, { t: 'decline' });
      dispatch({ type: 'end', reason: 'declined' });
    },
    [sendSignal]
  );

  /** Ask the caller to offer again, because we have only just arrived on the
   *  topic and everything sent before now was broadcast to an empty room. */
  const nudge = useCallback(
    (peerId: string, callId: string) => {
      if (peerId) sendSignal(peerId, callId, { t: 'ready' });
    },
    [sendSignal]
  );

  /**
   * Everything that can start before the offer does.
   *
   * The lock-screen path used to spend its first seconds idle: the app booted,
   * subscribed to nothing the caller was on, and waited for a repeat of an offer
   * it could not have received. Four things happen here instead, in the order
   * they unblock the answer.
   *
   *   1. Join the caller's topic. The friend list is a query behind the app's
   *      first paint, and until it lands the hub holds no topics at all — the
   *      single largest part of the wait, and what made the rest of this
   *      invisible.
   *   2. Ask for the offer (`nudge`), rather than waiting out the repeat.
   *   3. Mint the TURN credentials, which is a network round trip that would
   *      otherwise sit between the offer arriving and the answer being built.
   *   4. Open the microphone — only for an accept, and only because the user
   *      has already tapped Answer. See `warmup.ts`.
   *
   * `open` — the notification body rather than one of its buttons — gets the
   * first two. The user has asked to see the call, not to answer it.
   */
  const prepareForCall = useCallback(
    (pending: PendingCall) => {
      const { callId, peerId, action } = pending;
      if (!callId || !peerId) return;
      // Already here — the app was running and the offer arrived over realtime
      // long before the notification was tapped. Nothing to prepare.
      if (offerRef.current?.callId === callId) return;

      awaited.current = { callId, peerId };
      setWakePeer(peerId);
      void iceServers();
      nudge(peerId, callId);
      if (action !== 'accept') return;

      const kind = pending.kind ?? 'voice';
      primeMedia(kind, (constraints) => navigator.mediaDevices.getUserMedia(constraints));
      // The screen the user is owed the moment the app is up: their friend's
      // name and "Connecting…", not the chat list and then an Answer button for
      // a call they have already answered. A no-op if a call is already on
      // screen — `ring` owns that case.
      dispatch({
        type: 'answering',
        callId,
        peerId,
        peerName: nicknameFor(peerId) ?? 'Someone',
        kind,
      });

      // An answer for a call that is no longer there: the caller gave up while
      // the phone was starting, and their hangup was broadcast to a topic this
      // device had not joined yet. Self-cancelling — `answer` and `teardown`
      // both clear what it checks — and much shorter than the connect timeout,
      // which is measured for a call that at least has two ends.
      setTimeout(() => {
        if (awaited.current?.callId === callId) dispatch({ type: 'end', reason: 'failed' });
      }, ANSWER_WAIT_MS);
    },
    [nudge]
  );

  const hangup = useCallback(() => {
    const current = stateRef.current;
    if (!isEngaged(current) || !current.peerId || !current.callId) return;
    sendSignal(current.peerId, current.callId, { t: 'hangup' });
    dispatch({ type: 'end', reason: 'hungup' });
  }, [sendSignal]);

  // ---- routing ------------------------------------------------------------

  const onSignal = useCallback(
    ({ peerId, callId, signal }: { peerId: string; callId: string; signal: Signal }) => {
      const current = stateRef.current;
      // The call we are holding an offer for is ours as much as the one in
      // state is. `dispatch` does not update `stateRef` — a render does — so
      // every signal that arrives between the ring and the next render finds a
      // state that has not heard of the call yet, and the candidates in that
      // window are the earliest and most useful ones there are.
      const pending = offerRef.current;
      const mine =
        (current.callId === callId && current.peerId === peerId) ||
        (pending?.callId === callId && pending.peerId === peerId);

      switch (signal.t) {
        case 'offer': {
          const action = routeOffer({
            state: current,
            pending,
            incoming: { callId, peerId, sdp: signal.sdp },
            polite: isPolite(me, peerId),
            // False while a call answered on the lock screen waits for the
            // offer that is arriving right now. Without it that offer reads as
            // an ICE restart of a connection that does not exist yet.
            connected: sessionRef.current !== null,
          });
          switch (action) {
            case 'ignore':
              return;
            case 'refresh':
              // Keep the newest. A later repeat carries the candidates the
              // first offer was gathered too early to hold, and the answer is
              // built from whatever is here when the user taps answer.
              if (pending) offerRef.current = { ...pending, sdp: signal.sdp };
              return;
            case 'replay-answer':
              sessionRef.current?.repeatAnswer();
              return;
            case 'restart':
              void sessionRef.current?.handle(signal);
              return;
            case 'yield':
              sessionRef.current?.close();
              sessionRef.current = null;
              setLocalStream(null);
              ring({ callId, peerId, sdp: signal.sdp, kind: signal.kind });
              return;
            case 'busy':
              sendSignal(peerId, callId, { t: 'busy' });
              return;
            case 'ring':
              ring({ callId, peerId, sdp: signal.sdp, kind: signal.kind });
              return;
          }
          return;
        }

        case 'answer':
          if (!mine) return;
          dispatch({ type: 'answered' });
          void sessionRef.current?.handle(signal);
          return;

        case 'ice':
          if (!mine) return;
          if (sessionRef.current) void sessionRef.current.handle(signal);
          else earlyCandidates.current.push(signal.candidate);
          return;

        case 'ready':
          // Their phone has just reached the topic — woken by the ring push and
          // starting up, most likely. Everything we broadcast before this
          // instant went to an empty room, so offer again now rather than
          // leaving them looking at "Connecting…" until the next repeat.
          if (mine && current.phase === 'dialing') sessionRef.current?.repeatOffer();
          return;

        case 'decline':
          if (mine) dispatch({ type: 'end', reason: 'remote-declined' });
          return;

        case 'busy':
          if (mine) dispatch({ type: 'end', reason: 'busy' });
          return;

        case 'hangup':
          if (mine) dispatch({ type: 'end', reason: 'remote-hungup' });
          return;
      }
    },
    [me, ring, sendSignal]
  );

  // Stable primitive dep, as in `usePresence`: re-subscribing on every array
  // identity would rebuild every topic each time the friend list refetches.
  //
  // The caller of a ring answered on the lock screen is in here before the
  // friend list is: that topic is the one the call is on, and waiting for a
  // query to finish before joining it is waiting for nothing.
  const peerKey = useMemo(() => {
    const all = new Set(friendIds);
    if (wakePeer) all.add(wakePeer);
    all.delete(me);
    return [...all].sort().join(',');
  }, [friendIds, wakePeer, me]);
  const peerList = useMemo(() => (peerKey ? peerKey.split(',') : []), [peerKey]);

  // Read at hub construction only. Keeping the peer set out of the effect's
  // deps is the point: the friend list lands mid-call on the lock-screen path,
  // and rebuilding the hub for it would drop the topic carrying that call.
  const peersRef = useRef(peerList);
  peersRef.current = peerList;

  /**
   * A topic that has just gone live.
   *
   * The first instant anything can be sent to that peer, and on the lock-screen
   * path the call we are waiting for is already in `awaited`. Asking here rather
   * than only when the decision was made is what covers a cold start: the
   * decision is taken while the hub is still joining, and a `ready` sent then
   * reaches nobody.
   */
  const onHubReady = useCallback(
    (peerId: string) => {
      const waiting = awaited.current;
      if (waiting?.peerId === peerId) nudge(peerId, waiting.callId);
    },
    [nudge]
  );

  useEffect(() => {
    const hub = openSignalHub({
      me,
      identity,
      peerIds: peersRef.current,
      onSignal,
      onReady: onHubReady,
    });
    hubRef.current = hub;
    return () => {
      hub.close();
      if (hubRef.current === hub) hubRef.current = null;
    };
  }, [me, identity, generation, onSignal, onHubReady]);

  // Topics come and go with the friend list; the hub keeps the ones that appear
  // in both sets, so a call in progress is undisturbed by a refetch.
  useEffect(() => {
    hubRef.current?.setPeers(peerList);
  }, [peerList]);

  // ---- effects that follow the phase --------------------------------------

  useEffect(() => {
    if (state.phase === 'ringing') startRingtone();
    else if (state.phase === 'dialing') startRingback();
    else stopRinging();
  }, [state.phase]);

  // The foreground service, which is what keeps the call alive once the screen
  // goes off. Started when there is media to protect, not while ringing.
  //
  // The routing goes with it rather than being set beside it: the service is
  // what puts the device in MODE_IN_COMMUNICATION, and a communication device
  // chosen before that call — which is what a separate effect raced into doing
  // — is discarded when the mode changes, leaving the first seconds of a voice
  // call on the speaker.
  const routeRef = useRef(state.speaker);
  routeRef.current = state.speaker;
  useEffect(() => {
    if (state.phase === 'connecting' || state.phase === 'active') {
      void startNativeCall(state.kind, state.peerName, routeRef.current);
    }
  }, [state.phase, state.kind, state.peerName]);

  // Later changes only — the initial route travelled with the service above,
  // and repeating it here would race the mode switch it is waiting on.
  const routedPhase = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'active' && state.phase !== 'connecting') {
      routedPhase.current = null;
      return;
    }
    if (routedPhase.current === state.callId) void setNativeSpeaker(state.speaker);
    routedPhase.current = state.callId;
  }, [state.speaker, state.phase, state.callId]);

  // Keep offering while we dial, so a phone the push has only just woken can
  // still find the call. Fast at first, because that is when it is booting, and
  // then slower for the rest of the ring. Stops of its own accord once the
  // answer arrives: the phase leaves `dialing`, and `repeatOffer` is a no-op
  // after that anyway.
  useEffect(() => {
    if (state.phase !== 'dialing') return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      sessionRef.current?.repeatOffer();
      const fast = Date.now() - started < OFFER_FAST_WINDOW_MS;
      timer = setTimeout(tick, fast ? OFFER_REPEAT_FAST_MS : OFFER_REPEAT_MS);
    };
    timer = setTimeout(tick, OFFER_REPEAT_FAST_MS);
    return () => clearTimeout(timer);
  }, [state.phase, state.callId]);

  // A decision that was taken before the offer arrived — answered on the lock
  // screen of a phone whose app the system had killed. See `accept`.
  useEffect(() => {
    if (state.phase !== 'ringing') return;
    const pending = armed.current;
    if (!pending || pending.callId !== state.callId) return;
    armed.current = null;
    if (pending.action === 'accept') accept();
    else decline();
  }, [state.phase, state.callId, accept, decline]);

  // Nobody answered, or nobody could be reached. Both ends time out
  // independently rather than one telling the other, so a caller who walked out
  // of signal still stops ringing.
  useEffect(() => {
    const waiting =
      state.phase === 'dialing' || state.phase === 'ringing' || state.phase === 'connecting';
    if (!waiting) return;
    const timer = setTimeout(
      () => {
        const current = stateRef.current;
        const connecting = current.phase === 'connecting';
        // Tell them, unless we are the side that was rung and never answered —
        // there is nothing to cancel on their end that their own timeout will
        // not reach at the same moment.
        if (current.peerId && current.callId && current.phase !== 'ringing') {
          sendSignal(current.peerId, current.callId, { t: 'hangup' });
        }
        dispatch({ type: 'end', reason: connecting ? 'failed' : 'unanswered' });
      },
      state.phase === 'connecting' ? CONNECT_TIMEOUT_MS : RING_TIMEOUT_MS
    );
    ringTimer.current = timer;
    return () => clearTimeout(timer);
  }, [state.phase, state.callId, sendSignal]);

  // Everything a call held goes back the moment it ends, rather than when the
  // screen clears — the camera must not stay lit for the four seconds someone
  // spends reading "call ended".
  useEffect(() => {
    if (state.phase !== 'ended') return;
    teardown();
    const timer = setTimeout(() => dispatch({ type: 'dismiss' }), ENDED_LINGER_MS);
    return () => clearTimeout(timer);
  }, [state.phase, teardown]);

  // ---- the notification's buttons -----------------------------------------

  const onNativeAction = useCallback(
    (pending: PendingCall) => {
      // Before the decision: this is what joins the topic the answer has to go
      // out on, and everything it starts overlaps the wait for the offer.
      prepareForCall(pending);
      if (pending.action === 'accept') accept(pending.callId);
      else if (pending.action === 'decline') decline(pending.callId);
    },
    [prepareForCall, accept, decline]
  );

  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    void (async () => {
      // A ring that woke the phone and was answered from the lock screen: the
      // app is only starting up now, and the decision was already made.
      const pending = await consumePendingCall();
      if (pending) onNativeAction(pending);
      handle = await onNativeCallAction(onNativeAction);
    })();
    return () => {
      void handle?.remove();
    };
  }, [onNativeAction]);

  // Signing out, or the provider unmounting, must not leave a call running with
  // the microphone open and a foreground service in the shade.
  useEffect(() => teardown, [teardown]);

  const api = useMemo<CallApi>(
    () => ({
      state,
      localStream,
      remoteStream,
      placeCall,
      // Wrapped, not passed: these take an optional call id for the lock-screen
      // path, and a button handler would hand them a MouseEvent as one.
      accept: () => accept(),
      decline: () => decline(),
      hangup,
      toggleMute: () => {
        const next = !stateRef.current.muted;
        sessionRef.current?.setMuted(next);
        dispatch({ type: 'mute', on: next });
      },
      toggleCamera: () => {
        const next = !stateRef.current.cameraOff;
        sessionRef.current?.setCameraOff(next);
        dispatch({ type: 'camera', off: next });
      },
      flipCamera: () => {
        const call = sessionRef.current;
        if (!call) return;
        void (async () => {
          // What the phone actually did, not what was asked: a device with one
          // camera reports the one it kept, and the self-view must not stop
          // mirroring for a flip that never happened.
          dispatch({ type: 'facing', facing: await call.flipCamera() });
        })();
      },
      toggleSpeaker: () => dispatch({ type: 'speaker', on: !stateRef.current.speaker }),
      dismiss: () => dispatch({ type: 'dismiss' }),
    }),
    [state, localStream, remoteStream, placeCall, accept, decline, hangup]
  );

  return <CallContext.Provider value={api}>{children}</CallContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCall(): CallApi {
  return useContext(CallContext);
}
