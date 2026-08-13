import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSession, mediaConstraints, type SessionDeps } from './session';
import type { CallKind, Signal } from './types';

// Minimal stand-ins for the browser objects. The point of injecting them is
// that the whole negotiation runs here, in the node environment, with no DOM
// and no WebRTC implementation anywhere.

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(
    public kind: 'audio' | 'video',
    /** Only to tell one camera's track from the other's in an assertion. */
    public label = ''
  ) {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

// `flipCamera` builds a fresh stream for the self-view, because a mutated one
// keeps its identity and re-renders nothing. Node has no MediaStream to build.
(globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
  constructor(tracks: FakeTrack[] = []) {
    return new FakeStream([...tracks]) as unknown as FakeStream;
  }
};

class FakeSender {
  constructor(public track: FakeTrack | null) {}
  async replaceTrack(track: FakeTrack | null) {
    this.track = track;
  }
}

class FakePeer {
  connectionState = 'new';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  candidates: RTCIceCandidateInit[] = [];
  added: FakeTrack[] = [];
  senders: FakeSender[] = [];
  offerOptions: RTCOfferOptions[] = [];
  closed = false;
  onicecandidate: ((e: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(public config: RTCConfiguration) {}

  addTrack(track: FakeTrack) {
    this.added.push(track);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
  getSenders() {
    return this.senders;
  }
  async createOffer(options: RTCOfferOptions = {}) {
    this.offerOptions.push(options);
    return { type: 'offer' as const, sdp: 'OFFER' };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'ANSWER' };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
  transition(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

interface Harness {
  session: CallSession;
  peer: FakePeer;
  sent: Signal[];
  stream: FakeStream;
  /** Every constraint set the call has asked the platform for. */
  captured: MediaStreamConstraints[];
  /** Self-view streams handed back, newest last. */
  local: FakeStream[];
  connected: number;
  failed: number;
}

function harness(
  options: { kind?: CallKind; polite?: boolean; flipFails?: boolean } = {}
): Harness {
  const kind = options.kind ?? 'voice';
  const stream = new FakeStream(
    kind === 'video'
      ? [new FakeTrack('audio'), new FakeTrack('video', 'user')]
      : [new FakeTrack('audio')]
  );
  const sent: Signal[] = [];
  const state = { connected: 0, failed: 0 };
  const captured: MediaStreamConstraints[] = [];
  const local: FakeStream[] = [];
  let peer!: FakePeer;

  const deps: SessionDeps = {
    createPeer: (config) => {
      peer = new FakePeer(config);
      return peer as unknown as RTCPeerConnection;
    },
    getMedia: async (constraints) => {
      captured.push(constraints);
      // A flip asks for one camera and no microphone; the first capture of the
      // call asks for everything.
      if (constraints.audio === false) {
        if (options.flipFails) throw new Error('NotReadableError');
        const facing = (constraints.video as MediaTrackConstraints).facingMode as string;
        return new FakeStream([new FakeTrack('video', facing)]) as unknown as MediaStream;
      }
      return stream as unknown as MediaStream;
    },
    send: (signal) => sent.push(signal),
    onRemoteStream: () => {},
    onLocalStream: (s) => local.push(s as unknown as FakeStream),
    onConnected: () => state.connected++,
    onFailed: () => state.failed++,
    iceServers: [{ urls: 'turn:relay:3478', username: 'u', credential: 'c' }],
    kind,
    polite: options.polite ?? true,
  };

  const session = new CallSession(deps);
  return {
    session,
    stream,
    sent,
    captured,
    local,
    get peer() {
      return peer;
    },
    get connected() {
      return state.connected;
    },
    get failed() {
      return state.failed;
    },
  } as Harness;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('media constraints', () => {
  it('always names the three audio processors', () => {
    // An Android WebView with echo cancellation off makes each person hear
    // themselves a beat late, which reads as a broken app.
    for (const kind of ['voice', 'video'] as const) {
      expect(mediaConstraints(kind).audio).toMatchObject({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
    }
  });

  it('asks for no camera at all on a voice call', () => {
    expect(mediaConstraints('voice').video).toBe(false);
    expect(mediaConstraints('video').video).toMatchObject({ facingMode: 'user' });
  });
});

describe('placing a call', () => {
  it('captures, offers, and sends the kind with it', async () => {
    const h = harness({ kind: 'video' });
    await h.session.startOutgoing();
    expect(h.peer.added).toHaveLength(2);
    expect(h.peer.localDescription).toMatchObject({ type: 'offer' });
    expect(h.sent).toEqual([{ t: 'offer', sdp: 'OFFER', kind: 'video' }]);
  });

  it('builds the connection with the ICE servers it was given', async () => {
    const h = harness();
    await h.session.startOutgoing();
    expect(h.peer.config.iceServers).toEqual([
      { urls: 'turn:relay:3478', username: 'u', credential: 'c' },
    ]);
  });
});

describe('answering a call', () => {
  it('applies their offer and sends an answer back', async () => {
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    expect(h.peer.remoteDescription).toMatchObject({ type: 'offer', sdp: 'THEIR_OFFER' });
    expect(h.sent).toEqual([{ t: 'answer', sdp: 'ANSWER' }]);
  });
});

describe('candidates', () => {
  it('queues candidates that beat the remote description, then flushes them in order', async () => {
    // The far end starts gathering as soon as it sets its local description,
    // so on a fast network its candidates routinely arrive before its offer.
    // Dropping them costs the direct path and forces every call onto the relay.
    const h = harness();
    await h.session.startOutgoing();
    await h.session.handle({ t: 'ice', candidate: { candidate: 'first' } });
    await h.session.handle({ t: 'ice', candidate: { candidate: 'second' } });
    expect(h.peer.candidates).toEqual([]);

    await h.session.handle({ t: 'answer', sdp: 'THEIR_ANSWER' });
    expect(h.peer.candidates).toEqual([{ candidate: 'first' }, { candidate: 'second' }]);
  });

  it('holds candidates that arrive before the connection exists at all', async () => {
    // `setup` waits on getUserMedia, which on the answering side of a call to a
    // locked phone is a slow second — with the far end already gathering. These
    // used to be dropped on the floor for want of anywhere to put them.
    const h = harness();
    const early = h.session.handle({ t: 'ice', candidate: { candidate: 'before-setup' } });
    await early;
    await h.session.acceptIncoming('THEIR_OFFER');
    expect(h.peer.candidates).toEqual([{ candidate: 'before-setup' }]);
  });

  it('applies later candidates immediately', async () => {
    const h = harness();
    await h.session.startOutgoing();
    await h.session.handle({ t: 'answer', sdp: 'A' });
    await h.session.handle({ t: 'ice', candidate: { candidate: 'late' } });
    expect(h.peer.candidates).toEqual([{ candidate: 'late' }]);
  });

  it('sends its own candidates but not the end-of-gathering null', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.peer.onicecandidate?.({ candidate: { candidate: 'mine' } });
    h.peer.onicecandidate?.({ candidate: null });
    expect(h.sent.filter((s) => s.t === 'ice')).toEqual([
      { t: 'ice', candidate: { candidate: 'mine' } },
    ]);
  });

  it('survives a candidate the connection rejects', async () => {
    // Chrome rejects candidates for a bundled m-line it has discarded. That is
    // not a call failure and must not surface as a rejected promise.
    const h = harness();
    await h.session.startOutgoing();
    await h.session.handle({ t: 'answer', sdp: 'A' });
    h.peer.addIceCandidate = async () => {
      throw new Error('unknown ufrag');
    };
    await expect(h.session.handle({ t: 'ice', candidate: {} })).resolves.toBeUndefined();
  });
});

describe('collisions', () => {
  it('ignores an answer arriving with no offer outstanding', async () => {
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    const before = h.peer.remoteDescription;
    await h.session.handle({ t: 'answer', sdp: 'STRAY' });
    expect(h.peer.remoteDescription).toBe(before);
  });

  it('lets the impolite side keep its own offer when both ends offer at once', async () => {
    const h = harness({ polite: false });
    await h.session.startOutgoing();
    await h.session.handle({ t: 'offer', sdp: 'THEIRS', kind: 'voice' });
    expect(h.peer.remoteDescription).toBeNull();
    expect(h.sent.filter((s) => s.t === 'answer')).toEqual([]);
  });

  it('has the polite side conform', async () => {
    const h = harness({ polite: true });
    await h.session.startOutgoing();
    await h.session.handle({ t: 'offer', sdp: 'THEIRS', kind: 'voice' });
    expect(h.peer.remoteDescription).toMatchObject({ sdp: 'THEIRS' });
    expect(h.sent.filter((s) => s.t === 'answer')).toHaveLength(1);
  });
});

describe('track toggles', () => {
  it('disables rather than stops, so unmuting needs no renegotiation', async () => {
    const h = harness({ kind: 'video' });
    await h.session.startOutgoing();
    h.session.setMuted(true);
    const [audio, video] = h.stream.tracks;
    expect(audio.enabled).toBe(false);
    expect(audio.stopped).toBe(false);
    // The camera is a separate control and must not follow the mute.
    expect(video.enabled).toBe(true);

    h.session.setCameraOff(true);
    expect(video.enabled).toBe(false);
    h.session.setMuted(false);
    expect(audio.enabled).toBe(true);
    expect(video.enabled).toBe(false);
  });
});

describe('flipping the camera', () => {
  async function video() {
    const h = harness({ kind: 'video' });
    await h.session.startOutgoing();
    return h;
  }

  it('replaces the track on the sender rather than renegotiating', async () => {
    // `replaceTrack` with a track of the same kind needs no new offer, so the
    // far end sees the picture change and nothing else. Adding and removing
    // tracks instead would mean an offer, an answer, and a black rectangle on
    // both phones for as long as that took.
    const h = await video();
    const before = h.sent.length;

    expect(await h.session.flipCamera()).toBe('environment');

    const sender = h.peer.getSenders().find((s) => s.track?.kind === 'video');
    expect(sender?.track?.label).toBe('environment');
    expect(h.sent).toHaveLength(before);
  });

  it('asks for one camera and no second microphone', async () => {
    const h = await video();
    await h.session.flipCamera();
    expect(h.captured[1]).toEqual({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  });

  it('releases the camera it turned away from', async () => {
    // Two cameras held open is a phone that says the app is recording the room
    // it just stopped looking at.
    const h = await video();
    const first = h.stream.getVideoTracks()[0];
    await h.session.flipCamera();
    expect(first.stopped).toBe(true);
  });

  it('hands back a new stream, because the same one re-renders nothing', async () => {
    const h = await video();
    await h.session.flipCamera();
    const shown = h.local[h.local.length - 1];
    expect(shown).not.toBe(h.stream);
    expect(shown.getVideoTracks()[0].label).toBe('environment');
    // The microphone is the one already on the call, not a second one.
    expect(shown.getAudioTracks()).toEqual(h.stream.getAudioTracks());
  });

  it('flips back', async () => {
    const h = await video();
    await h.session.flipCamera();
    expect(await h.session.flipCamera()).toBe('user');
  });

  it('does not turn the picture back on', async () => {
    // The camera-off toggle belongs to the call, not to whichever track is
    // serving it.
    const h = await video();
    h.session.setCameraOff(true);
    await h.session.flipCamera();
    expect(h.local[h.local.length - 1].getVideoTracks()[0].enabled).toBe(false);
  });

  it('carries on with the camera it has when the capture fails', async () => {
    // A camera busy elsewhere, or a permission revoked mid-call. Not a reason
    // to end a call that is working.
    const h = harness({ kind: 'video', flipFails: true });
    await h.session.startOutgoing();
    const sender = h.peer.getSenders().find((s) => s.track?.kind === 'video');
    const before = sender?.track;

    expect(await h.session.flipCamera()).toBe('user');

    expect(sender?.track).toBe(before);
    expect(h.local).toEqual([]);
  });

  it('says nothing on a voice call, which has no camera to turn', async () => {
    const h = harness();
    await h.session.startOutgoing();
    expect(await h.session.flipCamera()).toBe('user');
    expect(h.captured).toHaveLength(1);
  });

  it('says nothing after the call is closed', async () => {
    const h = await video();
    h.session.close();
    expect(await h.session.flipCamera()).toBe('user');
    expect(h.captured).toHaveLength(1);
  });
});

describe('teardown', () => {
  it('stops every local track and closes the connection', async () => {
    // The one that matters: a closed peer connection leaves capture running,
    // so the camera light stays on and Android keeps showing the mic indicator
    // after the call has visibly ended.
    const h = harness({ kind: 'video' });
    await h.session.startOutgoing();
    h.session.close();
    expect(h.stream.tracks.every((t) => t.stopped)).toBe(true);
    expect(h.peer.closed).toBe(true);
  });

  it('is safe to call twice', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.session.close();
    expect(() => h.session.close()).not.toThrow();
  });

  it('ignores signals after closing', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.session.close();
    await expect(h.session.handle({ t: 'ice', candidate: {} })).resolves.toBeUndefined();
  });
});

describe('connection state', () => {
  it('reports connected and failed', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.peer.transition('connected');
    expect(h.connected).toBe(1);
    h.peer.transition('failed');
    expect(h.failed).toBe(1);
  });

  it('restarts ICE from the offering side after a drop', async () => {
    // This is what carries a call across a wifi-to-cellular handover.
    vi.useFakeTimers();
    const h = harness();
    await h.session.startOutgoing();
    await h.session.handle({ t: 'answer', sdp: 'A' });
    h.peer.transition('disconnected');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.peer.offerOptions[h.peer.offerOptions.length - 1]).toEqual({ iceRestart: true });
  });

  it('does not restart from the answering side, which would re-collide', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    h.peer.transition('disconnected');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.peer.offerOptions).toEqual([]);
  });

  it('abandons a scheduled restart if the link heals first', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.startOutgoing();
    h.peer.transition('disconnected');
    h.peer.transition('connected');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.peer.offerOptions.filter((o) => o.iceRestart)).toEqual([]);
  });
});

describe('repeating the offer', () => {
  it('re-sends the same offer while nobody has answered', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.session.repeatOffer();
    h.session.repeatOffer();

    expect(h.sent).toEqual([
      { t: 'offer', sdp: 'OFFER', kind: 'voice' },
      { t: 'offer', sdp: 'OFFER', kind: 'voice' },
      { t: 'offer', sdp: 'OFFER', kind: 'voice' },
    ]);
  });

  it('sends whatever the local description holds now, candidates included', async () => {
    // A real browser adds each candidate to `localDescription` as it gathers
    // it, so a repeat carries more than the offer before it did — which is the
    // point, and is why the far end compares ICE ufrags rather than SDP text.
    const h = harness();
    await h.session.startOutgoing();
    h.peer.localDescription = { type: 'offer', sdp: 'OFFER\r\na=candidate:1 1 udp 1 h 1 typ host' };
    h.sent.length = 0;

    h.session.repeatOffer();

    expect(h.sent).toEqual([
      { t: 'offer', sdp: 'OFFER\r\na=candidate:1 1 udp 1 h 1 typ host', kind: 'voice' },
    ]);
  });

  it('stops once the answer has arrived', async () => {
    const h = harness();
    await h.session.startOutgoing();
    await h.session.handle({ t: 'answer', sdp: 'THEIR_ANSWER' });
    h.sent.length = 0;

    h.session.repeatOffer();

    // A repeat after the call is negotiated would renegotiate a working call.
    expect(h.sent).toEqual([]);
  });

  it('says nothing from the answering side', async () => {
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    h.sent.length = 0;

    h.session.repeatOffer();

    expect(h.sent).toEqual([]);
  });

  it('says nothing after the call is closed', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.session.close();
    h.sent.length = 0;

    h.session.repeatOffer();

    expect(h.sent).toEqual([]);
  });
});

describe('repeating the answer', () => {
  it('says the answer again when the caller is still asking', async () => {
    // The caller stops repeating the instant our answer lands. One more repeat
    // after we answered means it never arrived — a phone unlocked to answer
    // rebuilds its realtime socket at exactly that moment — and this is what
    // rescues the call instead of both ends waiting out the ring timeout.
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    h.sent.length = 0;

    h.session.repeatAnswer();

    expect(h.sent).toEqual([{ t: 'answer', sdp: 'ANSWER' }]);
  });

  it('carries the candidates gathered since, which the first answer had none of', async () => {
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    h.peer.localDescription = { type: 'answer', sdp: 'ANSWER\r\na=candidate:1 1 udp 1 h 1 typ host' };
    h.sent.length = 0;

    h.session.repeatAnswer();

    expect(h.sent).toEqual([
      { t: 'answer', sdp: 'ANSWER\r\na=candidate:1 1 udp 1 h 1 typ host' },
    ]);
  });

  it('says nothing from the calling side, which has an offer to repeat instead', async () => {
    const h = harness();
    await h.session.startOutgoing();
    h.sent.length = 0;

    h.session.repeatAnswer();

    expect(h.sent).toEqual([]);
  });

  it('says nothing after the call is closed', async () => {
    const h = harness();
    await h.session.acceptIncoming('THEIR_OFFER');
    h.session.close();
    h.sent.length = 0;

    h.session.repeatAnswer();

    expect(h.sent).toEqual([]);
  });
});
