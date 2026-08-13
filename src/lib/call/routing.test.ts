import { describe, expect, it } from 'vitest';
import { iceUfrag, routeOffer, sameIceSession, type CallLike, type OfferRef } from './routing';

// Shaped like the real thing, because the bug this file exists for is a
// property of real SDP and not of a placeholder string.
const OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:F7gI',
  'a=ice-pwd:x9cl+kSxKPjSHiHhVJ0Mkbjq',
  'a=mid:0',
].join('\r\n');

/**
 * The same offer, two seconds later.
 *
 * `repeatOffer` re-sends `pc.localDescription.sdp`, and a browser adds each
 * candidate to the local description as it gathers it. So the repeat of an
 * unchanged offer is *not* the same string — which is the whole reason this
 * routing cannot compare SDP.
 */
const REPEAT = `${OFFER}\r\na=candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host generation 0`;

/** An ICE restart. The one thing that really does start a new ICE session. */
const RESTART = OFFER.replace('a=ice-ufrag:F7gI', 'a=ice-ufrag:Qz2W');

const from = (sdp: string): OfferRef => ({ callId: 'call-1', peerId: 'sam', sdp });

function at(partial: Partial<CallLike>): CallLike {
  return { phase: 'idle', callId: null, peerId: null, ...partial };
}

describe('ice ufrag', () => {
  it('reads the credential that identifies an ICE session', () => {
    expect(iceUfrag(OFFER)).toBe('F7gI');
    expect(iceUfrag('v=0\r\nm=audio 9 RTP/AVP 0')).toBeNull();
  });

  it('calls a repeat carrying newly gathered candidates the same session', () => {
    expect(sameIceSession(OFFER, REPEAT)).toBe(true);
  });

  it('calls a restart a different one', () => {
    expect(sameIceSession(OFFER, RESTART)).toBe(false);
  });

  it('falls back to comparing the text when there is no ufrag to read', () => {
    expect(sameIceSession('OFFER', 'OFFER')).toBe(true);
    expect(sameIceSession('OFFER', 'OTHER')).toBe(false);
  });
});

describe('an offer for the call already ringing', () => {
  const ringing = at({ phase: 'ringing', callId: 'call-1', peerId: 'sam' });
  const pending = from(OFFER);

  it('keeps the newer offer rather than answering it as a second call', () => {
    // The bug this replaces: the repeat was read as a fresh call from someone
    // we were already engaged with, so the ringing phone told the caller it was
    // busy — and then went on ringing a caller who had already given up.
    expect(routeOffer({ state: ringing, pending, incoming: from(REPEAT), polite: true })).toBe(
      'refresh'
    );
  });

  it('never rings twice for one call, even before the ring has been dispatched', () => {
    // The provider's view of its own state is a render behind the ring it just
    // dispatched, so an offer arriving in that window finds it still idle.
    expect(
      routeOffer({ state: at({}), pending, incoming: from(REPEAT), polite: true })
    ).toBe('refresh');
  });

  it('does not send busy for its own call', () => {
    for (const sdp of [OFFER, REPEAT, RESTART]) {
      expect(routeOffer({ state: ringing, pending, incoming: from(sdp), polite: true })).not.toBe(
        'busy'
      );
    }
  });
});

describe('an offer once we have answered', () => {
  const connecting = at({ phase: 'connecting', callId: 'call-1', peerId: 'sam' });
  const active = at({ phase: 'active', callId: 'call-1', peerId: 'sam' });
  const pending = from(REPEAT);

  it('says the answer again, because the caller is still asking', () => {
    // The caller stops repeating the moment our answer lands. Another repeat
    // after we answered means it never did — a phone that unlocked to answer
    // rebuilds its socket at exactly that instant — and one more broadcast is
    // all that rescues the call.
    expect(routeOffer({ state: connecting, pending, incoming: from(REPEAT), polite: true })).toBe(
      'replay-answer'
    );
  });

  it('leaves a connected call alone', () => {
    expect(routeOffer({ state: active, pending, incoming: from(REPEAT), polite: true })).toBe(
      'refresh'
    );
  });

  it('renegotiates only for a real ICE restart', () => {
    expect(routeOffer({ state: active, pending, incoming: from(RESTART), polite: true })).toBe(
      'restart'
    );
  });
});

describe('the first offer for a call answered on the lock screen', () => {
  // The app was killed, the push rang the phone, the user tapped Answer, and
  // the state went to `connecting` before any offer could reach the device.
  const preAccepted = at({ phase: 'connecting', callId: 'call-1', peerId: 'sam' });

  it('is the call itself, not an ICE restart of a connection that does not exist', () => {
    expect(
      routeOffer({
        state: preAccepted,
        pending: null,
        incoming: from(OFFER),
        polite: true,
        connected: false,
      })
    ).toBe('ring');
  });

  it('is still a restart once there is something to restart', () => {
    expect(
      routeOffer({
        state: preAccepted,
        pending: from(OFFER),
        incoming: from(RESTART),
        polite: true,
        connected: true,
      })
    ).toBe('restart');
  });

  it('does not re-ring the repeats that follow it', () => {
    // The answer is being built — the session exists a moment later than the
    // decision — and every repeat in that window has to be harmless.
    expect(
      routeOffer({
        state: preAccepted,
        pending: from(OFFER),
        incoming: from(REPEAT),
        polite: true,
        connected: false,
      })
    ).toBe('replay-answer');
  });
});

describe('an offer that lost a race', () => {
  it('is ignored once we have ended the call', () => {
    // Otherwise the ended screen is replaced by the same call ringing again,
    // seconds after it was declined.
    expect(
      routeOffer({
        state: at({ phase: 'ended', callId: 'call-1', peerId: 'sam' }),
        pending: null,
        incoming: from(REPEAT),
        polite: true,
      })
    ).toBe('ignore');
  });
});

describe('a genuinely new offer', () => {
  it('rings when there is nothing else happening', () => {
    expect(
      routeOffer({ state: at({}), pending: null, incoming: from(OFFER), polite: true })
    ).toBe('ring');
  });

  it('rings after the ended screen, so someone can call straight back', () => {
    expect(
      routeOffer({
        state: at({ phase: 'ended', callId: 'old', peerId: 'sam' }),
        pending: null,
        incoming: from(OFFER),
        polite: true,
      })
    ).toBe('ring');
  });

  it('tells a third party we are busy', () => {
    expect(
      routeOffer({
        state: at({ phase: 'active', callId: 'call-1', peerId: 'sam' }),
        pending: null,
        incoming: { callId: 'call-9', peerId: 'kim', sdp: OFFER },
        polite: true,
      })
    ).toBe('busy');
  });

  it('tells the same person we are busy when they ring again on a new call', () => {
    expect(
      routeOffer({
        state: at({ phase: 'active', callId: 'call-1', peerId: 'sam' }),
        pending: null,
        incoming: { callId: 'call-9', peerId: 'sam', sdp: OFFER },
        polite: true,
      })
    ).toBe('busy');
  });
});

describe('both people dialling at once', () => {
  const dialing = at({ phase: 'dialing', callId: 'mine', peerId: 'sam' });
  const theirs: OfferRef = { callId: 'theirs', peerId: 'sam', sdp: OFFER };

  it('has the polite side answer theirs', () => {
    expect(routeOffer({ state: dialing, pending: null, incoming: theirs, polite: true })).toBe(
      'yield'
    );
  });

  it('has the impolite side keep dialling, and not answer with busy', () => {
    // Busy here would end both calls at once: theirs by our reply, ours by
    // their reply to it.
    expect(routeOffer({ state: dialing, pending: null, incoming: theirs, polite: false })).toBe(
      'ignore'
    );
  });
});
