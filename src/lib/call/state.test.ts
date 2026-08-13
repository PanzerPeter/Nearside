import { describe, expect, it } from 'vitest';
import {
  callDuration,
  callReducer,
  defaultSpeaker,
  endLabel,
  formatDuration,
  idleCall,
  isEngaged,
  isPolite,
  type CallState,
} from './state';

/** A call in whatever phase a test needs, without restating every field. */
function at(partial: Partial<CallState>): CallState {
  return { ...idleCall, ...partial };
}

const dial = {
  type: 'dial' as const,
  callId: 'c1',
  peerId: 'bob',
  peerName: 'Bob',
  kind: 'voice' as const,
};
const incoming = {
  type: 'incoming' as const,
  callId: 'c2',
  peerId: 'bob',
  peerName: 'Bob',
  kind: 'video' as const,
};

describe('audio routing default', () => {
  it('starts a video call on the speaker and a voice call on the earpiece', () => {
    expect(defaultSpeaker('video')).toBe(true);
    expect(defaultSpeaker('voice')).toBe(false);
  });

  it('applies the default when the call starts', () => {
    expect(callReducer(idleCall, dial).speaker).toBe(false);
    expect(callReducer(idleCall, incoming).speaker).toBe(true);
  });
});

describe('glare resolution', () => {
  it('gives the two ends opposite answers', () => {
    expect(isPolite('alice', 'bob')).toBe(true);
    expect(isPolite('bob', 'alice')).toBe(false);
  });

  it('never lets both ends yield', () => {
    // The whole point: exactly one side backs down, whatever the ids are.
    for (const [a, b] of [
      ['00000000', 'ffffffff'],
      ['a1b2', 'a1b3'],
      ['9', 'z'],
    ]) {
      expect(isPolite(a, b)).not.toBe(isPolite(b, a));
    }
  });
});

describe('engagement', () => {
  it('treats every live phase as busy', () => {
    for (const phase of ['dialing', 'ringing', 'connecting', 'active'] as const) {
      expect(isEngaged(at({ phase }))).toBe(true);
    }
  });

  it('does not treat the ended screen as busy, so you can ring straight back', () => {
    expect(isEngaged(at({ phase: 'ended', reason: 'remote-hungup' }))).toBe(false);
    expect(isEngaged(idleCall)).toBe(false);
  });
});

describe('accepting', () => {
  it('moves a ringing call to connecting', () => {
    const state = callReducer(idleCall, incoming);
    expect(callReducer(state, { type: 'accept' }).phase).toBe('connecting');
  });

  it('ignores an accept that arrives when nothing is ringing', () => {
    const state = at({ phase: 'active' });
    expect(callReducer(state, { type: 'accept' })).toBe(state);
  });

  it('ignores a remote answer for a call we did not place', () => {
    const state = callReducer(idleCall, incoming);
    expect(callReducer(state, { type: 'answered' })).toBe(state);
  });
});

describe('answered on the lock screen, before the offer arrived', () => {
  const answering = {
    type: 'answering' as const,
    callId: 'c3',
    peerId: 'bob',
    peerName: 'Bob',
    kind: 'video' as const,
  };

  it('goes straight to connecting, with no Answer button in between', () => {
    const state = callReducer(idleCall, answering);
    expect(state.phase).toBe('connecting');
    expect(state.callId).toBe('c3');
    expect(state.outgoing).toBe(false);
    // The call screen is what the user sees while the app finishes starting,
    // so it has to name the right person and route audio the right way.
    expect(state.peerName).toBe('Bob');
    expect(state.speaker).toBe(true);
  });

  it('leaves a call already on screen alone', () => {
    // A stale notification for some other call, tapped while this one rings.
    const ringing = callReducer(idleCall, incoming);
    expect(callReducer(ringing, answering)).toBe(ringing);
    const live = at({ phase: 'active', callId: 'c9' });
    expect(callReducer(live, answering)).toBe(live);
  });

  it('takes the offer that finally arrives without leaving connecting', () => {
    // `ring` dispatches `incoming` and accepts it in the same batch. Neither
    // step may bounce the screen back to a ring the user already answered.
    const pre = callReducer(idleCall, answering);
    expect(callReducer(pre, { type: 'accept' })).toBe(pre);
  });
});

describe('connecting', () => {
  it('stamps the moment media started', () => {
    const state = callReducer(callReducer(idleCall, dial), { type: 'answered' });
    const live = callReducer(state, { type: 'connected', at: 1_000 });
    expect(live.phase).toBe('active');
    expect(live.connectedAt).toBe(1_000);
  });

  it('keeps the original stamp across an ICE restart', () => {
    // A mid-call network change re-fires `connected`. Taking the new stamp
    // would reset the duration readout to zero every time wifi wobbled.
    const live = at({ phase: 'connecting', connectedAt: 1_000 });
    expect(callReducer(live, { type: 'connected', at: 90_000 }).connectedAt).toBe(1_000);
  });
});

describe('the caller name that arrives late', () => {
  // The ring does not wait on a profile lookup: putting a request over a link
  // that has just woken a locked phone in front of the ring meant a phone that
  // rang seconds late, or slept again before it rang at all.
  it('fills the placeholder in once the lookup returns', () => {
    const ringing = callReducer(idleCall, incoming);
    const named = callReducer(ringing, {
      type: 'peer-name',
      callId: incoming.callId,
      peerName: '@bob',
    });
    expect(named.peerName).toBe('@bob');
  });

  it('ignores an answer for a call that has since been replaced', () => {
    const other = callReducer(idleCall, dial);
    expect(
      callReducer(other, { type: 'peer-name', callId: incoming.callId, peerName: '@bob' })
    ).toBe(other);
  });

  it('never blanks the name it already has', () => {
    const ringing = callReducer(idleCall, incoming);
    expect(callReducer(ringing, { type: 'peer-name', callId: incoming.callId, peerName: '' })).toBe(
      ringing
    );
  });
});

describe('ending', () => {
  it('records the reason', () => {
    const state = callReducer(idleCall, dial);
    expect(callReducer(state, { type: 'end', reason: 'remote-declined' })).toMatchObject({
      phase: 'ended',
      reason: 'remote-declined',
    });
  });

  it('keeps the first reason when our own hangup echoes back', () => {
    // We hang up, the peer answers with a hangup of their own. Taking the
    // second would relabel every call you ended as one they ended.
    const state = callReducer(callReducer(idleCall, dial), {
      type: 'end',
      reason: 'hungup',
    });
    expect(callReducer(state, { type: 'end', reason: 'remote-hungup' }).reason).toBe('hungup');
  });

  it('ignores a hangup for a call that already cleared', () => {
    expect(callReducer(idleCall, { type: 'end', reason: 'remote-hungup' })).toBe(idleCall);
  });

  it('clears back to idle only from the ended screen', () => {
    const ended = at({ phase: 'ended', reason: 'hungup' });
    expect(callReducer(ended, { type: 'dismiss' })).toEqual(idleCall);
    const live = at({ phase: 'active' });
    expect(callReducer(live, { type: 'dismiss' })).toBe(live);
  });
});

describe('duration', () => {
  it('is null for a call that never connected', () => {
    expect(callDuration(at({ phase: 'ended', reason: 'unanswered' }), 5_000)).toBeNull();
  });

  it('counts whole seconds from the connect stamp', () => {
    expect(callDuration(at({ connectedAt: 1_000 }), 65_400)).toBe(64);
  });

  it('never goes negative if the clock steps backwards', () => {
    expect(callDuration(at({ connectedAt: 10_000 }), 9_000)).toBe(0);
  });

  it('formats under and over an hour', () => {
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(605)).toBe('10:05');
    expect(formatDuration(3_661)).toBe('1:01:01');
  });
});

describe('end labels', () => {
  it('reads differently on each end of the same unanswered call', () => {
    expect(endLabel(at({ reason: 'unanswered', outgoing: true }))).toBe('No answer');
    expect(endLabel(at({ reason: 'unanswered', outgoing: false }))).toBe('Missed call');
  });

  it('distinguishes a cancelled call from a completed one', () => {
    expect(endLabel(at({ reason: 'hungup', outgoing: true }))).toBe('Call cancelled');
    expect(endLabel(at({ reason: 'hungup', outgoing: true, connectedAt: 1 }))).toBe('Call ended');
  });

  it('names the trust refusals rather than showing a generic failure', () => {
    // These two are the whole reason the call never happened, and a user who
    // sees "could not connect" will simply try again.
    expect(endLabel(at({ reason: 'key-changed' }))).toMatch(/key changed/i);
    expect(endLabel(at({ reason: 'no-key' }))).toMatch(/no encryption key/i);
  });
});
