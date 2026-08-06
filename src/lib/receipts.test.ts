import { describe, expect, it } from 'vitest';
import { statusFor, type Receipt } from './receipts';

const PEER = '00000000-0000-0000-0000-00000000000b';
const ME = '00000000-0000-0000-0000-00000000000a';

function receipt(delivered: string | null, read: string | null): Receipt {
  return { user_id: PEER, peer_id: ME, delivered_at: delivered, read_at: read };
}

const T1 = '2026-07-20T10:00:00.000Z';
const T2 = '2026-07-20T10:00:05.000Z';
const T3 = '2026-07-20T10:00:10.000Z';

describe('statusFor', () => {

  it('reports sent when the peer has no receipt row at all', () => {
    expect(statusFor(T2, null)).toBe('sent');
  });

  it('reports sent when both watermarks trail the message', () => {
    expect(statusFor(T3, receipt(T1, T1))).toBe('sent');
  });

  it('reports delivered when delivered has passed but read has not', () => {
    expect(statusFor(T2, receipt(T3, T1))).toBe('delivered');
  });

  it('treats a watermark exactly equal to the message time as inclusive, for both delivered and read', () => {
    expect(statusFor(T2, receipt(T2, null))).toBe('delivered');
    expect(statusFor(T2, receipt(T2, T2))).toBe('read');
  });

  it('reports read when the read watermark is well past the message', () => {
    expect(statusFor(T1, receipt(T3, T3))).toBe('read');
  });

  it('treats the +00:00 offset form PostgREST actually returns the same as a Z-suffixed instant', () => {
    const zForm = receipt('2026-07-20T10:00:05.000Z', null);
    const offsetForm = receipt('2026-07-20T10:00:05+00:00', null);
    expect(statusFor(T2, zForm)).toBe(statusFor(T2, offsetForm));
    expect(statusFor(T2, offsetForm)).toBe('delivered');
  });
});
