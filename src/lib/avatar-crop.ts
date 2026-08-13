/**
 * Geometry for the avatar cropper. The maths lives here rather than in the
 * component so it can be tested at all: there is no DOM test setup, and every
 * bug this file can have (a pan that lets background through the circle, a
 * crop that lands somewhere other than what was framed) is arithmetic.
 *
 * The model: a square viewport of `viewport` CSS pixels, with the image drawn
 * centred and scaled to *cover* it, then scaled again by `zoom` (≥ 1) and
 * translated by an offset measured in CSS pixels from the viewport's centre.
 */

/** Smallest zoom the UI offers — 1 is exactly "covers the circle". */
export const MIN_ZOOM = 1;
/** Past this the source is mush at any sane avatar resolution. */
export const MAX_ZOOM = 4;

export interface Offset {
  x: number;
  y: number;
}

export interface CropRect {
  /** Source rectangle in the image's own pixels, square by construction. */
  sx: number;
  sy: number;
  size: number;
}

/**
 * Scale at which the image's short edge exactly fills the viewport. A degenerate
 * image (zero or non-finite edge) reports 1 so callers divide by something real.
 */
export function coverScale(width: number, height: number, viewport: number): number {
  const shortest = Math.min(width, height);
  if (!Number.isFinite(shortest) || shortest <= 0 || viewport <= 0) return 1;
  return viewport / shortest;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Pull an offset back inside the image. Panning further than this would show
 * the modal's background inside the circle, which then gets baked into the
 * uploaded avatar as a transparent wedge.
 */
export function clampOffset(
  offset: Offset,
  width: number,
  height: number,
  viewport: number,
  zoom: number
): Offset {
  const scale = coverScale(width, height, viewport) * clampZoom(zoom);
  // Half of whatever the image overhangs the viewport by, per axis. At zoom 1
  // the short edge has no slack at all, so that axis pins to 0.
  const slackX = Math.max(0, (width * scale - viewport) / 2);
  const slackY = Math.max(0, (height * scale - viewport) / 2);
  const x = Number.isFinite(offset.x) ? offset.x : 0;
  const y = Number.isFinite(offset.y) ? offset.y : 0;
  return {
    x: Math.min(slackX, Math.max(-slackX, x)),
    y: Math.min(slackY, Math.max(-slackY, y)),
  };
}

/**
 * The square of source pixels currently framed by the viewport — what the
 * canvas draws to produce the upload. Inverse of the transform above: an
 * offset that moved the image right shows source further left.
 */
export function cropRect(
  width: number,
  height: number,
  viewport: number,
  zoom: number,
  offset: Offset
): CropRect {
  const scale = coverScale(width, height, viewport) * clampZoom(zoom);
  const clamped = clampOffset(offset, width, height, viewport, zoom);
  const size = Math.min(width, height, viewport / scale);
  return {
    sx: (width - size) / 2 - clamped.x / scale,
    sy: (height - size) / 2 - clamped.y / scale,
    size,
  };
}

/**
 * Where a pinch's midpoint sits after the zoom changes. Without this the image
 * zooms about the viewport's centre and whatever the user had their fingers on
 * slides away from them.
 *
 * `focus` is the midpoint in CSS pixels relative to the viewport's centre.
 */
export function zoomAbout(offset: Offset, focus: Offset, fromZoom: number, toZoom: number): Offset {
  const from = clampZoom(fromZoom);
  const to = clampZoom(toZoom);
  const ratio = to / from;
  return {
    x: focus.x + (offset.x - focus.x) * ratio,
    y: focus.y + (offset.y - focus.y) * ratio,
  };
}

/** Distance between two touch points, for pinch. */
export function pinchDistance(a: Offset, b: Offset): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
