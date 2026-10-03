import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { decodeQr } from './qr-decode';
import { DECODE_SIZES } from './scan';
import { QUIET_ZONE } from './qr';

// Shaped like the real thing: a uuid, a base64 X25519 key, a token.
const CONNECT =
  'nearside:v1:3f2b8a10-5c4e-4d7a-9b1e-2a6c8f0d4e11:q1Lx8Vh0cJm3T9zR2pYw5KdN7aE4fB6gU1sH0iO8lQ=:7KQ4M2XA';
const SAFETY = 'nearside-safety:v1:' + '123456789012'.repeat(5);

const [SMALL, LARGE] = DECODE_SIZES;
/** The centre square of a 1920×1080 stream, which is what the scanner asks for. */
const CAMERA = 1080;

/**
 * The centre square of a camera frame, the way `QrScanner` hands it over: the
 * code drawn as `QrCode.tsx` draws it (dark on light, quiet zone included),
 * filling `fill` of the square a little off-centre, with the contrast of a
 * screen photographed by another phone and Gaussian sensor noise of `sigma` on
 * every camera pixel — then area-averaged down to `size`, as the canvas does.
 *
 * Noise has to go on at camera resolution, before the downscale. Added after,
 * it skips the averaging the real pipeline gets for free, and the decoder
 * fails on frames a phone would read.
 */
function frame(text: string, { fill, sigma, size }: { fill: number; sigma: number; size: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const span = n + QUIET_ZONE * 2;
  const codeSide = CAMERA * fill;
  const x0 = (CAMERA - codeSide) / 2 + CAMERA * 0.07 * (1 - fill);
  const y0 = (CAMERA - codeSide) / 2 - CAMERA * 0.05 * (1 - fill);

  // Seeded, so a failure reproduces; four uniforms summed approximate a normal.
  let seed = 31;
  const uniform = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const normal = () => (uniform() + uniform() + uniform() + uniform() - 2) * 1.73;

  const raw = new Float32Array(CAMERA * CAMERA);
  for (let y = 0; y < CAMERA; y += 1) {
    for (let x = 0; x < CAMERA; x += 1) {
      const inside = x >= x0 && x < x0 + codeSide && y >= y0 && y < y0 + codeSide;
      const mx = Math.floor(((x + 0.5 - x0) / codeSide) * span) - QUIET_ZONE;
      const my = Math.floor(((y + 0.5 - y0) / codeSide) * span) - QUIET_ZONE;
      const dark = inside && mx >= 0 && my >= 0 && mx < n && my < n && qr.isDark(my, mx);
      raw[y * CAMERA + x] = (!inside ? 110 : dark ? 60 : 200) + normal() * sigma;
    }
  }

  const data = new Uint8ClampedArray(size * size * 4);
  const step = CAMERA / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      let count = 0;
      for (let yy = Math.floor(y * step); yy < Math.ceil((y + 1) * step); yy += 1) {
        for (let xx = Math.floor(x * step); xx < Math.ceil((x + 1) * step); xx += 1) {
          sum += raw[yy * CAMERA + xx];
          count += 1;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = sum / count;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

function decode(f: ReturnType<typeof frame>) {
  return decodeQr(f.data, f.width, f.height);
}

describe('decodeQr', () => {
  it('reads a connect code and a safety number in dim light at the small size', () => {
    expect(decode(frame(CONNECT, { fill: 0.35, sigma: 16, size: SMALL }))).toBe(CONNECT);
    expect(decode(frame(SAFETY, { fill: 0.35, sigma: 16, size: SMALL }))).toBe(SAFETY);
  });

  it('reads a code held at arm’s length at the large size', () => {
    expect(decode(frame(CONNECT, { fill: 0.22, sigma: 6, size: LARGE }))).toBe(CONNECT);
  });

  // The two sizes exist because each fails where the other reads. If either
  // of these starts passing, one size is enough and the alternation can go.
  it('needs both sizes', () => {
    expect(decode(frame(CONNECT, { fill: 0.22, sigma: 6, size: SMALL }))).toBeNull();
    expect(decode(frame(CONNECT, { fill: 0.35, sigma: 16, size: LARGE }))).toBeNull();
  });

  it('returns null for a frame with no code in it', () => {
    const side = SMALL;
    const data = new Uint8ClampedArray(side * side * 4).fill(128);
    expect(decodeQr(data, side, side)).toBeNull();
  });
});
