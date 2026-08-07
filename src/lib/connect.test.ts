import { describe, expect, it } from 'vitest';
import { parseConnectPayload, parseSafetyPayload, safetyPayload } from './connect';

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
