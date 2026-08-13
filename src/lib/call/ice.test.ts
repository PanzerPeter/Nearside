import { describe, expect, it } from 'vitest';
import { isFresh, normalizeIceServers, ttlToExpiry } from './ice';

describe('normalizing a provider response', () => {
  it('accepts what Cloudflare actually returns', () => {
    // One entry bundling the STUN url with all three TURN transports under a
    // single credential, verbatim from the provider's documented response. A
    // peer connection built from a shape this missed has no usable servers and
    // fails like a network problem rather than like a bug.
    const urls = [
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ];
    expect(normalizeIceServers([{ urls, username: 'xxxx', credential: 'yyyy' }])).toEqual([
      { urls, username: 'xxxx', credential: 'yyyy' },
    ]);
  });

  it('accepts a bare object, in case a provider drops the array', () => {
    expect(
      normalizeIceServers({
        urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'u',
        credential: 'c',
      })
    ).toHaveLength(1);
  });

  it('accepts one entry per url, which other providers return', () => {
    expect(
      normalizeIceServers([{ urls: 'stun:a:3478' }, { urls: 'turn:b:3478', username: 'u', credential: 'c' }])
    ).toHaveLength(2);
  });

  it('drops entries with no usable url', () => {
    expect(normalizeIceServers([{ urls: '' }, { urls: [] }, { username: 'u' }, null, 'nope'])).toEqual([]);
  });

  it('omits credentials that are not strings rather than passing them through', () => {
    expect(normalizeIceServers({ urls: 'turn:a:3478', username: 7, credential: null })).toEqual([
      { urls: 'turn:a:3478' },
    ]);
  });

  it('survives a response that is not a list at all', () => {
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers('turn:a')).toEqual([]);
  });
});

describe('credential lifetime', () => {
  it('uses the ttl the provider gave', () => {
    expect(ttlToExpiry(600, 1_000)).toBe(601_000);
  });

  it('falls back to an hour when the ttl is missing or nonsense', () => {
    expect(ttlToExpiry(undefined, 0)).toBe(3_600_000);
    expect(ttlToExpiry(Number.NaN, 0)).toBe(3_600_000);
    expect(ttlToExpiry('soon', 0)).toBe(3_600_000);
  });

  it('clamps a ttl that would pin stale credentials for the life of the process', () => {
    expect(ttlToExpiry(999_999_999, 0)).toBe(12 * 60 * 60 * 1000);
    expect(ttlToExpiry(1, 0)).toBe(60_000);
  });
});

describe('freshness', () => {
  it('re-mints before expiry, not at it', () => {
    // Credentials that die during ICE gathering are worse than none: the call
    // half-starts and then fails.
    const bundle = { servers: [], expiresAt: 100_000 };
    expect(isFresh(bundle, 0)).toBe(true);
    expect(isFresh(bundle, 50_000)).toBe(false);
    expect(isFresh(bundle, 100_001)).toBe(false);
  });

  it('treats an empty cache as stale', () => {
    expect(isFresh(null, 0)).toBe(false);
  });
});
