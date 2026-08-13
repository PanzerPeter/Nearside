// One peer connection, from the first offer to the last track being stopped.
//
// Media never touches a server. `RTCPeerConnection` negotiates DTLS between the
// two devices and encrypts every packet with SRTP under keys derived from that
// handshake, so a TURN relay in the path forwards bytes it cannot read. What
// this file has to get right is everything around that: which side offers, what
// to do with candidates that arrive before there is anywhere to put them, and
// releasing the camera when it is over.
//
// Every browser object it needs is injected. That is not ceremony — it is what
// lets the whole negotiation run under the node test environment this repo
// uses, with no DOM and no WebRTC implementation present.

import type { CallKind, FacingMode, Signal } from './types';

/** Everything from the platform, so the negotiation itself is testable. */
export interface SessionDeps {
  createPeer: (config: RTCConfiguration) => RTCPeerConnection;
  getMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  send: (signal: Signal) => void;
  onRemoteStream: (stream: MediaStream) => void;
  /** Fires when the local stream is replaced rather than merely changed —
   *  swapping cameras is the only thing that does it. */
  onLocalStream: (stream: MediaStream) => void;
  onConnected: () => void;
  onFailed: () => void;
  iceServers: RTCIceServer[];
  kind: CallKind;
  /**
   * The tie-break from `isPolite`. Only consulted for a collision, which with
   * a fixed call kind means the two-simultaneous-offers case the provider has
   * already resolved. Kept here so a stray second offer on a live connection
   * cannot tear down a working call: the impolite side ignores it.
   */
  polite: boolean;
}

/**
 * Constraints for a call.
 *
 * The three audio processors are named explicitly rather than left to the
 * WebView's defaults. An Android WebView with echo cancellation off produces a
 * call where each person hears themselves a beat late, which reads as "the app
 * is broken" rather than as a missing constraint.
 */
export function mediaConstraints(
  kind: CallKind,
  facing: FacingMode = 'user'
): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (kind === 'voice') return { audio, video: false };
  return { audio, video: cameraConstraints(facing) };
}

/**
 * One camera.
 *
 * `facingMode` as a plain value, never `{ exact }`: exact throws on a phone
 * with only one camera, and a flip that cannot happen should leave the call
 * alone rather than end it.
 */
export function cameraConstraints(facing: FacingMode): MediaTrackConstraints {
  return { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
}

/** How long a `disconnected` connection is given to heal on its own before an
 *  ICE restart. Most wifi-to-cellular handovers recover inside this window,
 *  and restarting into a link that was about to come back costs a longer gap
 *  than doing nothing. */
const ICE_RESTART_DELAY_MS = 2_000;

export class CallSession {
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private remote: MediaStream | null = null;
  /** Candidates that arrived before there was a remote description to attach
   *  them to. The far end starts gathering the moment it sets its local
   *  description, so on a fast network its first candidates routinely beat its
   *  own offer here; dropping them costs the direct path and forces the relay. */
  private queued: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private closed = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while we are the side that offered, which is the side allowed to
   *  drive an ICE restart. Both ends restarting at once re-collides. */
  private offerer = false;
  /** Which camera is being sent. Only ever changes through `flipCamera`. */
  private facing: FacingMode = 'user';

  constructor(private deps: SessionDeps) {}

  get localStream(): MediaStream | null {
    return this.local;
  }

  /** Place the call: capture, offer, send. */
  async startOutgoing(): Promise<void> {
    this.offerer = true;
    await this.setup();
    if (this.closed || !this.pc) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.deps.send({ t: 'offer', sdp: offer.sdp ?? '', kind: this.deps.kind });
  }

  /**
   * Send the offer again, unchanged.
   *
   * Broadcast has no replay: an offer is relayed to whoever is subscribed at
   * that instant and is then gone. A phone woken by the ring push subscribes
   * seconds later and would find nothing to answer — so the dialling side
   * repeats itself until the answer comes back.
   *
   * Sent from `localDescription` rather than from the description `createOffer`
   * returned, so each repeat carries the candidates gathered since the last
   * one. That also means a repeat is *not* the same string as the offer before
   * it, which is why the far end tells a repeat from an ICE restart by the ICE
   * ufrag and never by comparing SDP — see `routing.ts`.
   *
   * A no-op once answered: `have-local-offer` is exactly the window in which
   * nobody has replied yet.
   */
  repeatOffer(): void {
    const pc = this.pc;
    if (this.closed || !pc || pc.signalingState !== 'have-local-offer') return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) return;
    this.deps.send({ t: 'offer', sdp, kind: this.deps.kind });
  }

  /** Answer a call: capture, apply their offer, send ours back. */
  async acceptIncoming(offerSdp: string): Promise<void> {
    this.offerer = false;
    await this.setup();
    if (this.closed || !this.pc) return;
    await this.applyRemote({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.deps.send({ t: 'answer', sdp: answer.sdp ?? '' });
  }

  /**
   * Say our answer again, unchanged.
   *
   * The mirror of `repeatOffer`, driven by the same fact: broadcast has no
   * replay and the answer is sent exactly once. A phone unlocked to answer a
   * call rebuilds its realtime socket at that very instant — `connection.ts`
   * treats the screen coming on as a wake — so the one answer it sends can go
   * into a channel that has not rejoined yet, and the caller then waits out the
   * full ring timeout for a call that was picked up. The caller still repeating
   * its offer is the evidence that happened, and is what asks for this.
   *
   * Free of charge: `localDescription` has collected our candidates by now, so
   * the replay carries them where the first answer had none.
   */
  repeatAnswer(): void {
    const pc = this.pc;
    if (this.closed || !pc || this.offerer) return;
    const local = pc.localDescription;
    if (!local || local.type !== 'answer' || !local.sdp) return;
    this.deps.send({ t: 'answer', sdp: local.sdp });
  }

  /**
   * Apply a signal from the far end.
   *
   * `offer` reaching a live connection is an ICE restart, not a new call — the
   * provider only routes the first offer to the ring. `hangup`, `decline` and
   * `busy` are the provider's business, not the connection's, and are ignored
   * here so there is one place that decides a call is over.
   */
  async handle(signal: Signal): Promise<void> {
    if (this.closed) return;

    // Before the connection exists there is still somewhere to put a candidate.
    // `setup` waits on `getUserMedia`, which on a cold WebView — the answering
    // side of a call to a locked phone, every time — is a slow second during
    // which the far end is already gathering. Dropping those costs the direct
    // path and can cost the call.
    if (signal.t === 'ice' && (!this.pc || !this.haveRemote)) {
      this.queued.push(signal.candidate);
      return;
    }
    if (!this.pc) return;

    switch (signal.t) {
      case 'answer':
        if (this.pc.signalingState !== 'have-local-offer') return;
        await this.applyRemote({ type: 'answer', sdp: signal.sdp });
        return;

      case 'offer': {
        // A collision: both ends offered. The impolite side keeps its own and
        // lets the polite side conform, which is the only way the two agree
        // without another round trip.
        if (this.pc.signalingState !== 'stable' && !this.deps.polite) return;
        await this.applyRemote({ type: 'offer', sdp: signal.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.deps.send({ t: 'answer', sdp: answer.sdp ?? '' });
        return;
      }

      case 'ice':
        // A candidate the far end could not use is not a call failure. Chrome
        // rejects candidates for a bundled m-line it has already discarded, and
        // throwing here would end a call that is about to connect fine.
        await this.pc.addIceCandidate(signal.candidate).catch(() => {});
        return;

      default:
        return;
    }
  }

  setMuted(muted: boolean): void {
    // `enabled`, not `stop()`. Stopping the track removes it from the
    // connection and unmuting would need a renegotiation; disabling it sends
    // silence and the call carries on undisturbed.
    for (const track of this.local?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  setCameraOff(off: boolean): void {
    for (const track of this.local?.getVideoTracks() ?? []) track.enabled = !off;
  }

  /**
   * Swap the front camera for the back one, or back again.
   *
   * `replaceTrack` on the existing sender, not a new track added to the
   * connection: replacing a track with one of the same kind needs no
   * renegotiation, so the far end sees the picture change and nothing else. An
   * `addTrack`/`removeTrack` pair would mean a fresh offer, an answer, and a
   * black rectangle on both phones for as long as that took.
   *
   * Audio is deliberately left out of the new capture. Asking for it again
   * would open a second microphone beside the one already on the call.
   *
   * Returns the camera now in use — unchanged if the phone has only one, which
   * is the case `facingMode` answers by giving back what it already had.
   */
  async flipCamera(): Promise<FacingMode> {
    const pc = this.pc;
    if (this.closed || !pc || this.deps.kind !== 'video' || !this.local) return this.facing;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return this.facing;

    const wanted: FacingMode = this.facing === 'user' ? 'environment' : 'user';
    let track: MediaStreamTrack | undefined;
    try {
      const capture = await this.deps.getMedia({ audio: false, video: cameraConstraints(wanted) });
      track = capture.getVideoTracks()[0];
      // Anything else the capture handed back is not going on the call and must
      // not be left holding the camera.
      for (const spare of capture.getTracks()) if (spare !== track) spare.stop();
    } catch {
      // A camera that is busy, or a permission revoked mid-call. The call still
      // has its original track and carries on.
      return this.facing;
    }
    if (!track) return this.facing;
    if (this.closed || !this.local) {
      track.stop();
      return this.facing;
    }

    const old = this.local.getVideoTracks()[0];
    // The camera-off toggle is a property of the call, not of the track that
    // happens to be serving it — flipping must not turn the picture back on.
    if (old) track.enabled = old.enabled;
    await sender.replaceTrack(track);
    if (old) {
      this.local.removeTrack(old);
      old.stop();
    }
    // A new stream rather than the same one mutated: the self-view is a React
    // prop, and an object that has not changed identity re-renders nothing.
    this.local = new MediaStream([...this.local.getAudioTracks(), track]);
    this.facing = wanted;
    this.deps.onLocalStream(this.local);
    return wanted;
  }

  /**
   * Tear down, releasing the hardware.
   *
   * Stopping the local tracks is the part that matters. A closed peer
   * connection leaves the capture devices running: the camera light stays on
   * and Android keeps showing the microphone indicator, which for this app is
   * not a cosmetic bug but the app appearing to record a room it is not in.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const track of this.local?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    this.local = null;
    this.remote = null;
    this.queued = [];
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.pc = null;
  }

  // ---- internals ----------------------------------------------------------

  private async setup(): Promise<void> {
    // Capture before the connection exists: a permission dialog the user
    // dismisses should leave no half-built peer connection behind, and on the
    // outgoing side it should happen before their phone rings.
    this.local = await this.deps.getMedia(mediaConstraints(this.deps.kind));
    if (this.closed) {
      for (const track of this.local.getTracks()) track.stop();
      return;
    }

    const pc = this.deps.createPeer({ iceServers: this.deps.iceServers });
    this.pc = pc;

    for (const track of this.local.getTracks()) pc.addTrack(track, this.local);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      // Null marks the end of gathering. There is nothing to send and the far
      // end does not need to be told.
      if (!candidate) return;
      const init =
        typeof (candidate as RTCIceCandidate).toJSON === 'function'
          ? (candidate as RTCIceCandidate).toJSON()
          : (candidate as RTCIceCandidateInit);
      this.deps.send({ t: 'ice', candidate: init });
    };

    pc.ontrack = (event) => {
      // Prefer the stream the far end grouped its tracks into; fall back to
      // collecting them ourselves, which is what some WebViews hand back.
      const stream = event.streams[0];
      if (stream) {
        this.remote = stream;
      } else {
        this.remote ??= new MediaStream();
        this.remote.addTrack(event.track);
      }
      this.deps.onRemoteStream(this.remote);
    };

    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      switch (pc.connectionState) {
        case 'connected':
          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = null;
          this.deps.onConnected();
          return;
        case 'disconnected':
          this.scheduleIceRestart();
          return;
        case 'failed':
          this.deps.onFailed();
          return;
        default:
          return;
      }
    };
  }

  private async applyRemote(description: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(description);
    this.haveRemote = true;
    const pending = this.queued;
    this.queued = [];
    for (const candidate of pending) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /**
   * Re-offer with fresh candidates after the path dies.
   *
   * This is what carries a call across a wifi-to-cellular handover: the old
   * candidate pair is gone, and without a restart the connection sits in
   * `disconnected` until it eventually fails. Only the offering side drives it,
   * because two simultaneous restarts collide the same way two offers do.
   */
  private scheduleIceRestart(): void {
    if (!this.offerer || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const pc = this.pc;
      if (this.closed || !pc || pc.connectionState !== 'disconnected') return;
      void (async () => {
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          this.deps.send({ t: 'offer', sdp: offer.sdp ?? '', kind: this.deps.kind });
        } catch {
          // Nothing better to try. The connection will reach `failed` on its
          // own and the provider ends the call with a reason.
        }
      })();
    }, ICE_RESTART_DELAY_MS);
  }
}
