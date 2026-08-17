import { useCallback, useEffect, useRef, useState } from 'react';
import { IDLE_SWIPE, swipeRelease, swipeStep, type SwipeState } from '../lib/swipe';

interface Options {
  /** Width of the action rail behind the row, in pixels. */
  railWidth: number;
  /** True while this row's rail should be open. Owned by the list, because
   *  only one row may be open at a time and a row cannot know about its
   *  siblings. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Off on a mouse: the desktop path is the menu, not a drag (which fights
   *  text selection and means nothing to a keyboard). */
  enabled: boolean;
}

/**
 * A list row that slides aside to reveal actions.
 *
 * Pointer events rather than touch events, so the same code path serves a
 * stylus, and `setPointerCapture` so a finger that leaves the row still
 * reports its moves — a row that froze halfway open because the finger drifted
 * onto the next one is the failure this prevents.
 *
 * The arithmetic is all in `lib/swipe.ts`; this holds the pointer plumbing and
 * nothing else.
 */
export function useSwipeActions({ railWidth, open, onOpenChange, enabled }: Options) {
  const [state, setState] = useState<SwipeState>(IDLE_SWIPE);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // The list can close this row (another one opened, or a chat was selected).
  // The offset has to follow, or the row stays parked over its own rail.
  useEffect(() => {
    setState((prev) => {
      if (prev.open === open) return prev;
      return { offset: open ? -railWidth : 0, open, axis: 'none' };
    });
  }, [open, railWidth]);

  const close = useCallback(() => {
    originRef.current = null;
    setState(IDLE_SWIPE);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Mouse drags are not a gesture here; see `enabled`.
      if (!enabled || e.pointerType === 'mouse') return;
      originRef.current = { x: e.clientX, y: e.clientY };
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const origin = originRef.current;
      if (!origin) return;
      const next = swipeStep(
        stateRef.current,
        e.clientX - origin.x,
        e.clientY - origin.y,
        railWidth
      );
      // Capture only once the gesture is known to be horizontal: taking the
      // pointer earlier would swallow the list's scroll.
      if (next.axis === 'x' && !e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setState(next);
    },
    [railWidth]
  );

  const finish = useCallback(() => {
    if (!originRef.current) return;
    originRef.current = null;
    const settled = swipeRelease(stateRef.current, railWidth);
    setState(settled);
    if (settled.open !== stateRef.current.open) onOpenChange(settled.open);
    else if (settled.open) onOpenChange(true);
  }, [railWidth, onOpenChange]);

  return {
    /** True while the row is being dragged, so the caller can suppress the tap
     *  that would otherwise open the conversation on release. */
    dragging: state.axis === 'x',
    offset: state.offset,
    style: {
      // Without this the WebView owns both axes: it reads the first few pixels
      // of a horizontal drag as a scroll, fires `pointercancel`, and stops
      // sending moves — so the axis lock below never sees enough travel and the
      // row does not move at all. `pan-y` keeps vertical scrolling native and
      // hands sideways movement to this hook. Same fix, same reason, as the
      // swipe-to-reply gesture on a message bubble.
      touchAction: 'pan-y',
      transform: `translateX(${state.offset}px)`,
      // No animation while the finger is down: the row is following it, and a
      // transition would make it lag behind by the duration.
      transition: state.axis === 'x' ? 'none' : 'transform 180ms ease-out',
    } as React.CSSProperties,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
    close,
  };
}
