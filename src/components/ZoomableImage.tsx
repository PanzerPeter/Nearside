import { useEffect, useRef, useState } from 'react';
import { clampView, IDENTITY, toggleZoom, zoomAt, type Point, type View } from '../lib/zoom';

/** A horizontal drag this long, at fit, is a request for the next picture. */
const SWIPE_PX = 50;
/** Two taps closer together than this are one double tap. */
const DOUBLE_TAP_MS = 300;

type Gesture =
  | { kind: 'pinch'; dist: number; mid: Point; view: View }
  | { kind: 'pan'; from: Point; view: View }
  | { kind: 'swipe'; from: Point }
  | null;

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * A picture in the viewer that can be looked into: pinch and drag on a phone,
 * double tap or double click to jump in and back, the wheel on a desktop.
 *
 * It owns every pointer that lands on it, swipe included. At fit a sideways
 * drag still steps through the conversation's pictures; zoomed in, the same
 * drag moves around the picture instead, which is the only reading of it that
 * makes sense once there is more picture than screen.
 *
 * Keyed by its source in the viewer, so stepping to the next picture starts at
 * fit rather than inheriting where the last one was looked at.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  onError,
  onSwipe,
}: {
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
  /** -1 for the previous picture, 1 for the next. */
  onSwipe?: (direction: -1 | 1) => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [gesturing, setGesturing] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(null);
  const lastTap = useRef(0);

  /** Where a client point sits relative to the picture's unzoomed centre. */
  function local(clientX: number, clientY: number): Point {
    const el = ref.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: clientX - (r.left + r.width / 2 - v.x),
      y: clientY - (r.top + r.height / 2 - v.y),
    };
  }

  function size() {
    const el = ref.current;
    return { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
  }

  // Native and non-passive: React's wheel listener is passive, and the page
  // behind would scroll under a zoom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { w, h } = size();
      const v = viewRef.current;
      setView(zoomAt(v, v.scale * Math.exp(-e.deltaY * 0.002), local(e.clientX, e.clientY), w, h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function begin() {
    const pts = [...pointers.current.values()];
    const v = viewRef.current;
    if (pts.length >= 2) {
      gesture.current = { kind: 'pinch', dist: distance(pts[0], pts[1]), mid: midpoint(pts[0], pts[1]), view: v };
    } else if (pts.length === 1) {
      gesture.current = v.scale > 1 ? { kind: 'pan', from: pts[0], view: v } : { kind: 'swipe', from: pts[0] };
    } else {
      gesture.current = null;
    }
    setGesturing(gesture.current !== null && gesture.current.kind !== 'swipe');
  }

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      draggable={false}
      onError={onError}
      className={`${className ?? ''} touch-none select-none ${
        gesturing ? '' : 'transition-transform duration-200 ease-out'
      } ${view.scale > 1 ? 'cursor-grab' : 'cursor-zoom-in'}`}
      style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
        begin();
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
        const g = gesture.current;
        const { w, h } = size();
        const pts = [...pointers.current.values()];
        if (g?.kind === 'pinch' && pts.length >= 2) {
          const mid = midpoint(pts[0], pts[1]);
          const zoomed = zoomAt(g.view, (g.view.scale * distance(pts[0], pts[1])) / g.dist, g.mid, w, h);
          setView(clampView({ ...zoomed, x: zoomed.x + mid.x - g.mid.x, y: zoomed.y + mid.y - g.mid.y }, w, h));
        } else if (g?.kind === 'pan' && pts.length === 1) {
          setView(
            clampView({ ...g.view, x: g.view.x + pts[0].x - g.from.x, y: g.view.y + pts[0].y - g.from.y }, w, h)
          );
        }
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        const at = pointers.current.get(e.pointerId);
        pointers.current.delete(e.pointerId);
        const g = gesture.current;
        if (g?.kind === 'swipe' && at && pointers.current.size === 0) {
          const dx = at.x - g.from.x;
          const dy = at.y - g.from.y;
          const moved = Math.hypot(dx, dy);
          if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
            onSwipe?.(dx > 0 ? -1 : 1);
          } else if (moved < 10) {
            const now = performance.now();
            if (now - lastTap.current < DOUBLE_TAP_MS) {
              const { w, h } = size();
              setView(toggleZoom(viewRef.current, at, w, h));
              lastTap.current = 0;
            } else {
              lastTap.current = now;
            }
          }
        } else if (g?.kind === 'pan' && at && pointers.current.size === 0 && Math.hypot(at.x - g.from.x, at.y - g.from.y) < 10) {
          // A tap while zoomed: the second of a pair takes it back to fit.
          const now = performance.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            setView(IDENTITY);
            lastTap.current = 0;
          } else {
            lastTap.current = now;
          }
        }
        begin();
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        begin();
      }}
    />
  );
}
