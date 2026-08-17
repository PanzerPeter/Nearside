// The arithmetic behind a row that slides aside to show its actions.
//
// Here rather than in the row component for the reason every other calculation
// in this app is: the node suite can reach it, and a gesture whose thresholds
// are only ever exercised by a finger is a gesture nobody can regression-test.
//
// The axis lock is the load-bearing part. A list scrolls vertically and its
// rows swipe horizontally, and without a lock decided on the first few pixels
// every scroll drags a row a little sideways.

/** How far the row must travel before releasing it opens the rail. Below the
 *  platform's own fling distances on purpose: this is a deliberate action, not
 *  a flick past. */
export const ACTIVATE_PX = 64;
/** Where the axis lock is decided. */
const LOCK_PX = 8;
/** Resistance past the rail, as a fraction of the extra distance. */
const RUBBER = 0.25;

export interface SwipeState {
  /** Negative: the row has moved left, revealing the rail on the right. */
  offset: number;
  open: boolean;
  axis: 'none' | 'x' | 'y';
}

export const IDLE_SWIPE: SwipeState = { offset: 0, open: false, axis: 'none' };

/** Advance the gesture by the finger's total travel from where it went down. */
export function swipeStep(
  state: SwipeState,
  dx: number,
  dy: number,
  railWidth: number
): SwipeState {
  let axis = state.axis;
  if (axis === 'none' && Math.max(Math.abs(dx), Math.abs(dy)) >= LOCK_PX) {
    axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  }
  if (axis !== 'x') return { ...state, axis };

  // An open row starts its travel from under the rail, so a swipe back to the
  // right closes it rather than doing nothing.
  const raw = Math.min(0, dx + (state.open ? -railWidth : 0));
  const past = Math.max(0, -raw - railWidth);
  const offset = past > 0 ? -(railWidth + past * RUBBER) : raw;
  return { offset, open: state.open, axis };
}

/** Settle the row where the finger left it: open, or back home. */
export function swipeRelease(state: SwipeState, railWidth: number): SwipeState {
  const open = -state.offset >= ACTIVATE_PX;
  return { offset: open ? -railWidth : 0, open, axis: 'none' };
}
