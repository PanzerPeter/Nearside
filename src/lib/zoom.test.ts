import { describe, expect, it } from 'vitest';
import { clampView, IDENTITY, MAX_SCALE, toggleZoom, zoomAt } from './zoom';

const W = 400;
const H = 300;

describe('zoom', () => {
  it('keeps the point under the fingers where it was', () => {
    const at = { x: 100, y: -50 };
    const view = zoomAt(IDENTITY, 2, at, W, H);
    // Content under `at` before: (at - t) / s = at. After, it must map back.
    expect((at.x - view.x) / view.scale).toBeCloseTo(at.x);
    expect((at.y - view.y) / view.scale).toBeCloseTo(at.y);
  });

  it('never zooms out past fit, and fit is centred', () => {
    expect(clampView({ scale: 0.5, x: 30, y: 30 }, W, H)).toEqual(IDENTITY);
  });

  it('caps the scale and the pan', () => {
    const view = clampView({ scale: 10, x: 1e6, y: -1e6 }, W, H);
    expect(view.scale).toBe(MAX_SCALE);
    expect(view.x).toBe(((MAX_SCALE - 1) * W) / 2);
    expect(view.y).toBe(-((MAX_SCALE - 1) * H) / 2);
  });

  it('double tap goes in, and the next one comes back out', () => {
    const zoomed = toggleZoom(IDENTITY, { x: 0, y: 0 }, W, H);
    expect(zoomed.scale).toBeGreaterThan(1);
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, W, H)).toEqual(IDENTITY);
  });
});
