import { describe, expect, it } from 'vitest';
import { QUIET_ZONE, qrMatrix } from './qr';

const CONNECT_PAYLOAD =
  'nearside:v1:29a4782b-b764-43a4-87e5-21a606b05ff3:' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:WQJ39CZQ';

/** Every `Mx,y` coordinate pair in the path. */
function points(d: string): Array<[number, number]> {
  return [...d.matchAll(/M(\d+),(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('qr matrix', () => {
  it('produces a code for a real connect payload', () => {
    const { d, modules } = qrMatrix(CONNECT_PAYLOAD);
    expect(modules).toBeGreaterThan(20);
    expect(points(d).length).toBeGreaterThan(100);
  });

  it('surrounds the code with a four-module quiet zone', () => {
    // The whole reason this module exists. Without the margin the code renders
    // and never scans, which is indistinguishable from "QR is broken".
    const { d, size, modules } = qrMatrix(CONNECT_PAYLOAD);
    expect(size).toBe(modules + QUIET_ZONE * 2);

    for (const [x, y] of points(d)) {
      expect(x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(x).toBeLessThan(size - QUIET_ZONE);
      expect(y).toBeLessThan(size - QUIET_ZONE);
    }
  });

  it('draws the top-left finder pattern flush against the quiet zone', () => {
    // The finder is a 7x7 block in every corner of every QR. If it does not
    // start exactly at the quiet-zone offset, the grid has been shifted and
    // the margin on one side has quietly been eaten.
    const { d } = qrMatrix(CONNECT_PAYLOAD);
    const drawn = new Set(points(d).map(([x, y]) => `${x},${y}`));
    for (let i = 0; i < 7; i += 1) {
      expect(drawn.has(`${QUIET_ZONE + i},${QUIET_ZONE}`)).toBe(true);
      expect(drawn.has(`${QUIET_ZONE},${QUIET_ZONE + i}`)).toBe(true);
    }
  });

  it('grows the version rather than truncating a longer payload', () => {
    const short = qrMatrix('nearside:v1:short');
    const long = qrMatrix(CONNECT_PAYLOAD);
    expect(long.modules).toBeGreaterThan(short.modules);
  });

  it('is deterministic for the same text', () => {
    expect(qrMatrix(CONNECT_PAYLOAD).d).toEqual(qrMatrix(CONNECT_PAYLOAD).d);
  });
});
