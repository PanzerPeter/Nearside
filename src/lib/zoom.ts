// Pinch, double-tap and wheel zoom for a picture in the viewer, as pure math.
//
// A view is `translate(x, y) scale(scale)` about the element's centre, and
// every point here is measured from that centre in screen pixels. Kept apart
// from the component so the one part that is easy to get subtly wrong — the
// point under the fingers drifting as the scale changes — is testable in node.

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Where a double tap lands: close enough to read text in a photo of a menu,
 *  not so close that the tap point is all there is. */
export const DOUBLE_TAP_SCALE = 2.5;

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

/**
 * Keep the picture covering its box: no zooming out past fit, and no panning
 * an edge in past the box's edge. `w`/`h` are the element's unscaled size.
 */
export function clampView(view: View, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  if (scale === MIN_SCALE) return IDENTITY;
  const maxX = ((scale - 1) * w) / 2;
  const maxY = ((scale - 1) * h) / 2;
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

/** Change the scale while the content under `at` stays under `at`. */
export function zoomAt(view: View, scale: number, at: Point, w: number, h: number): View {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const ratio = next / view.scale;
  return clampView(
    { scale: next, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio },
    w,
    h
  );
}

/** A double tap: in to `DOUBLE_TAP_SCALE` at the tap, or back out to fit. */
export function toggleZoom(view: View, at: Point, w: number, h: number): View {
  return view.scale > MIN_SCALE ? IDENTITY : zoomAt(view, DOUBLE_TAP_SCALE, at, w, h);
}
