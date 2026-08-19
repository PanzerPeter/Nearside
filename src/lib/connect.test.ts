import { describe, expect, it } from 'vitest';
import {
  connectOutcome,
  parseConnectPayload,
  parseSafetyPayload,
  safetyPayload,
} from './connect';

describe('connect payload', () => {
  it('round-trips a well-formed payload', () => {
    const text = 'nearside:v1:11111111-1111-1111-1111-111111111111:cHVia2V5:ABCDEFGH';
    expect(parseConnectPayload(text)).toEqual({
      userId: '11111111-1111-1111-1111-111111111111',
      publicKey: 'cHVia2V5',
      token: 'ABCDEFGH',
    });
  });

  it('rejects an unknown scheme', () => {
    expect(parseConnectPayload('https://example.com/x')).toBeNull();
  });

  it('rejects a future version rather than guessing', () => {
    expect(parseConnectPayload('nearside:v2:a:b:c')).toBeNull();
  });

  it('rejects a malformed user id', () => {
    expect(parseConnectPayload('nearside:v1:not-a-uuid:cHVia2V5:ABCDEFGH')).toBeNull();
  });
});

describe('safety payload', () => {
  it('round-trips a grouped number, ignoring the grouping', () => {
    expect(parseSafetyPayload(safetyPayload('12345 67890'))).toBe('1234567890');
  });

  it('rejects a connect QR, so scanning the wrong code cannot verify anyone', () => {
    expect(
      parseSafetyPayload('nearside:v1:11111111-1111-1111-1111-111111111111:cHVia2V5:ABCDEFGH')
    ).toBeNull();
  });

  it('rejects non-digits', () => {
    expect(parseSafetyPayload('nearside-safety:v1:12345abcde')).toBeNull();
  });
});

describe('connectOutcome', () => {
  const ME = 'me';
  const THEM = 'them';

  it('sends a request when the pair has no row', () => {
    expect(connectOutcome(undefined, ME)).toBe('send');
  });

  it('says nothing to do when the two are already friends', () => {
    expect(connectOutcome({ id: 'f', requester_id: THEM, status: 'accepted' }, ME)).toBe(
      'already-friends'
    );
  });

  it('says the request is already out when it was mine', () => {
    expect(connectOutcome({ id: 'f', requester_id: ME, status: 'pending' }, ME)).toBe(
      'already-sent'
    );
  });

  // The declined-then-hidden case. Their pending request is not in the list to
  // be accepted from, because declining hid them; holding their code is the
  // consent that was going to be given by tapping accept.
  it('accepts their pending request rather than pointing at a list', () => {
    expect(connectOutcome({ id: 'f', requester_id: THEM, status: 'pending' }, ME)).toBe('accept');
  });
});
