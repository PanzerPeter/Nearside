import { useCallback, useRef, useState } from 'react';

// Threshold the swipe must cross to fire the reply action, and the max the
// bubble can travel (past the threshold it drags with heavy resistance so it
// feels rubber-banded rather than runaway).
const TRIGGER_PX = 56;
const MAX_PX = 84;
// Ignore tiny finger jitters and vertical-scroll intent: only lock into a
// horizontal swipe once movement is clearly sideways.
const START_SLOP = 10;

interface Options {
  enabled: boolean;
  onReply: () => void;
  // Which way a pull counts as a reply gesture: +1 for the friend's messages
  // (sit on the left, swipe right), -1 for your own (sit on the right, swipe
  // left) — so both sides swipe away from the edge they're anchored to.
  // `offset` itself stays a non-negative magnitude; the caller applies this
  // sign when turning it into a translate.
  direction: 1 | -1;
}

/**
 * Touch swipe-to-reply. Returns the current pull magnitude (for animating the
 * bubble + revealing a reply icon behind it, sign applied by the caller per
 * `direction`) and pointer handlers.
 *
 * Touch only on purpose: a mouse drag would clash with text selection on
 * desktop, where double-click-to-reply is the equivalent gesture instead.
 */
export function useSwipeToReply({ enabled, onReply, direction }: Options) {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  // null = undecided, true = horizontal swipe, false = vertical scroll (bail).
  const locked = useRef<boolean | null>(null);
  // Set when a real horizontal swipe happened, so the synthetic click that
  // follows pointerup can be swallowed instead of toggling the tap menu.
  const swiped = useRef(false);

  const reset = useCallback(() => {
    start.current = null;
    locked.current = null;
    setOffset(0);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || e.pointerType !== 'touch') return;
      start.current = { x: e.clientX, y: e.clientY };
      locked.current = null;
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start.current) return;
      const dx = e.clientX - start.current.x;
      const dy = e.clientY - start.current.y;

      if (locked.current === null) {
        if (Math.abs(dx) < START_SLOP && Math.abs(dy) < START_SLOP) return;
        // Commit to whichever axis dominates. Vertical wins → let the list scroll.
        locked.current = Math.abs(dx) > Math.abs(dy);
        if (!locked.current) {
          start.current = null;
          return;
        }
        swiped.current = true;
      }

      // Only a pull in the configured direction counts; clamp with resistance
      // beyond the trigger.
      const pull = Math.max(0, dx * direction);
      const eased = pull > TRIGGER_PX ? TRIGGER_PX + (pull - TRIGGER_PX) * 0.3 : pull;
      setOffset(Math.min(eased, MAX_PX));
    },
    [direction]
  );

  const onPointerUp = useCallback(() => {
    if (offset >= TRIGGER_PX) {
      navigator.vibrate?.(15);
      onReply();
    }
    reset();
  }, [offset, onReply, reset]);

  // True once (and cleared) if the most recent gesture was a horizontal swipe,
  // letting the caller ignore the click the browser fires after pointerup.
  const consumeSwipeClick = useCallback(() => {
    if (swiped.current) {
      swiped.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    offset,
    armed: offset >= TRIGGER_PX,
    swiping: offset > 0,
    consumeSwipeClick,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
    },
  };
}
