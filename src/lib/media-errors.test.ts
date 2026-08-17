import { describe, expect, it } from 'vitest';
import { describeMediaError } from './media-errors';
import { NO_PEER_KEY } from './sealed-body';

describe('describeMediaError', () => {
  it('names the rate limit before anything else', () => {
    expect(describeMediaError({ message: 'rate_limited_messages' })).toMatch(/too quickly/i);
  });

  it('says whose problem a missing peer key is', () => {
    const message = describeMediaError(new Error(NO_PEER_KEY));
    expect(message).toMatch(/has not published an encryption key/i);
    // The remedy belongs to the other person, so the sentence has to say so —
    // otherwise it reads as this device being broken.
    expect(message).toMatch(/their device/i);
  });

  it('tells a cloud-only gallery item apart from a failed send', () => {
    // What a DOMException from `arrayBuffer()` actually carries: a name, and
    // nothing else worth showing anyone.
    const denied = { name: 'NotReadableError', message: '' };
    expect(describeMediaError(denied)).toMatch(/could not be read/i);
    expect(describeMediaError(denied)).toMatch(/gallery/i);
  });

  it('names the device, not the server, when sealing runs out of room', () => {
    expect(describeMediaError({ name: 'RangeError', message: 'allocation failed' })).toMatch(
      /too large to encrypt on this device/i
    );
  });

  it('calls a missing migration a missing migration', () => {
    for (const code of ['PGRST204', 'PGRST205', '42703']) {
      expect(describeMediaError({ code, message: 'column x does not exist' })).toMatch(
        /migration is missing/i
      );
    }
  });

  it('separates a privilege failure from a policy failure', () => {
    expect(describeMediaError({ code: '42501', message: 'permission denied' })).not.toBe(
      describeMediaError({ code: 'PGRST116', message: '' })
    );
  });

  it('passes a check constraint through, since it names which one', () => {
    expect(
      describeMediaError({ code: '23514', message: 'violates check constraint "media_key_pair"' })
    ).toMatch(/media_key_pair/);
  });

  it('reports a dropped connection as one', () => {
    expect(describeMediaError(new TypeError('Failed to fetch'))).toMatch(/no connection/i);
  });

  it('falls through to the underlying message rather than a guess', () => {
    expect(describeMediaError({ code: 'XX000', message: 'unexpected server trouble' })).toBe(
      'unexpected server trouble'
    );
  });

  it('only produces the generic sentence when there is nothing at all to say', () => {
    expect(describeMediaError(null)).toBe('Could not send media.');
    expect(describeMediaError({ message: '   ' })).toBe('Could not send media.');
    expect(describeMediaError(undefined, 'Could not send that sticker.')).toBe(
      'Could not send that sticker.'
    );
  });
});
