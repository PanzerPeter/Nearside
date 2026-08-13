import { describe, expect, it } from 'vitest';
import {
  clampOffset,
  clampZoom,
  coverScale,
  cropRect,
  MAX_ZOOM,
  MIN_ZOOM,
  pinchDistance,
  zoomAbout,
} from './avatar-crop';

describe('coverScale', () => {
  it('fills the viewport from the short edge', () => {
    expect(coverScale(4000, 3000, 300)).toBeCloseTo(0.1);
    expect(coverScale(3000, 4000, 300)).toBeCloseTo(0.1);
  });

  it('upscales an image smaller than the viewport', () => {
    expect(coverScale(100, 100, 300)).toBeCloseTo(3);
  });

  it('answers 1 for a degenerate image rather than dividing by zero', () => {
    expect(coverScale(0, 0, 300)).toBe(1);
    expect(coverScale(NaN, 100, 300)).toBe(1);
  });
});

describe('clampZoom', () => {
  it('holds the offered range', () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it('treats a non-number as no zoom', () => {
    expect(clampZoom(NaN)).toBe(MIN_ZOOM);
  });
});

describe('clampOffset', () => {
  it('pins the short axis at zoom 1, where there is no slack', () => {
    // 4000x3000 covering a 300px square: 400x300 on screen. Height has none.
    expect(clampOffset({ x: 999, y: 999 }, 4000, 3000, 300, 1)).toEqual({ x: 50, y: 0 });
  });

  it('allows both axes once zoomed in', () => {
    // At 2x the drawn image is 800x600, so 250 and 150 of slack per side.
    expect(clampOffset({ x: 999, y: -999 }, 4000, 3000, 300, 2)).toEqual({ x: 250, y: -150 });
  });

  it('leaves an offset already inside the image alone', () => {
    expect(clampOffset({ x: 10, y: -10 }, 4000, 3000, 300, 2)).toEqual({ x: 10, y: -10 });
  });

  it('treats a non-number offset as centred', () => {
    expect(clampOffset({ x: NaN, y: NaN }, 4000, 3000, 300, 2)).toEqual({ x: 0, y: 0 });
  });
});

describe('cropRect', () => {
  it('takes the centred square at rest', () => {
    expect(cropRect(4000, 3000, 300, 1, { x: 0, y: 0 })).toEqual({ sx: 500, sy: 0, size: 3000 });
  });

  it('never leaves the image, however far the pan is pushed', () => {
    const wide = cropRect(4000, 3000, 300, 1, { x: -9999, y: -9999 });
    expect(wide.sx).toBe(1000);
    expect(wide.sy).toBe(0);
    expect(wide.sx + wide.size).toBeLessThanOrEqual(4000);

    const tall = cropRect(3000, 4000, 300, 1, { x: 9999, y: 9999 });
    expect(tall.sx).toBe(0);
    expect(tall.sy).toBe(0);
  });

  it('shrinks the source square as the zoom grows', () => {
    expect(cropRect(4000, 3000, 300, 2, { x: 0, y: 0 })).toEqual({
      sx: 1250,
      sy: 750,
      size: 1500,
    });
  });

  it('moves the source opposite the pan', () => {
    // Dragging the image right (+x) must reveal source further left.
    const scale = coverScale(4000, 3000, 300) * 2;
    const rect = cropRect(4000, 3000, 300, 2, { x: 20, y: 0 });
    expect(rect.sx).toBeCloseTo(1250 - 20 / scale);
  });

  it('stays inside a source smaller than the viewport', () => {
    const rect = cropRect(100, 200, 300, 1, { x: 0, y: 0 });
    expect(rect.size).toBe(100);
    expect(rect.sx).toBe(0);
    expect(rect.sy).toBe(50);
  });
});

describe('zoomAbout', () => {
  it('keeps the pinch midpoint under the fingers', () => {
    expect(zoomAbout({ x: 0, y: 0 }, { x: 50, y: 0 }, 1, 2)).toEqual({ x: -50, y: 0 });
  });

  it('is the identity when the zoom does not change', () => {
    expect(zoomAbout({ x: 7, y: -3 }, { x: 50, y: 20 }, 2, 2)).toEqual({ x: 7, y: -3 });
  });

  it('zooms about the centre when that is where the fingers are', () => {
    expect(zoomAbout({ x: 10, y: 10 }, { x: 0, y: 0 }, 1, 2)).toEqual({ x: 20, y: 20 });
  });
});

describe('pinchDistance', () => {
  it('measures the gap between two touches', () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
