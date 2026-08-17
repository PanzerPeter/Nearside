import { describe, expect, it } from 'vitest';
import { ACTIVATE_PX, swipeRelease, swipeStep, type SwipeState } from './swipe';

const idle: SwipeState = { offset: 0, open: false, axis: 'none' };
const RAIL = 216;

describe('swipeStep', () => {
  // A list that steals a scroll is a list you fight. Vertical intent wins the
  // tie and locks the gesture out for its whole life.
  it('locks to the vertical axis when the finger moves down first', () => {
    const s = swipeStep(idle, 4, 20, RAIL);
    expect(s.axis).toBe('y');
    expect(s.offset).toBe(0);
  });

  it('locks to the horizontal axis and follows the finger', () => {
    const s = swipeStep(idle, -30, 3, RAIL);
    expect(s.axis).toBe('x');
    expect(s.offset).toBe(-30);
  });

  it('stays locked out once the gesture is vertical', () => {
    const locked = swipeStep(idle, 4, 20, RAIL);
    expect(swipeStep(locked, -60, 20, RAIL).offset).toBe(0);
  });

  // Past the rail the row keeps moving, but slowly: an elastic edge says "this
  // is as far as it goes" without the row simply stopping dead under a finger.
  it('resists past the rail rather than stopping dead', () => {
    const s = swipeStep(idle, -(RAIL + 100), 0, RAIL);
    expect(-s.offset).toBeGreaterThan(RAIL);
    expect(-s.offset).toBeLessThan(RAIL + 100);
  });

  it('does not follow a swipe to the right on a closed row', () => {
    expect(swipeStep(idle, 40, 0, RAIL).offset).toBe(0);
  });

  // An open row swipes back: the finger's travel is added to where the row
  // already sits, so a right-swipe closes it.
  it('lets an open row be dragged shut', () => {
    const open: SwipeState = { offset: -RAIL, open: true, axis: 'x' };
    expect(swipeStep(open, 40, 0, RAIL).offset).toBe(-(RAIL - 40));
  });
});

describe('swipeRelease', () => {
  it('opens the rail when the row travelled far enough', () => {
    const s = swipeRelease({ offset: -(ACTIVATE_PX + 1), open: false, axis: 'x' }, RAIL);
    expect(s.open).toBe(true);
    expect(s.offset).toBe(-RAIL);
  });

  it('springs back when it did not', () => {
    const s = swipeRelease({ offset: -(ACTIVATE_PX - 1), open: false, axis: 'x' }, RAIL);
    expect(s.open).toBe(false);
    expect(s.offset).toBe(0);
  });

  it('closes an open row that was dragged most of the way back', () => {
    const s = swipeRelease({ offset: -10, open: true, axis: 'x' }, RAIL);
    expect(s.open).toBe(false);
    expect(s.offset).toBe(0);
  });

  // The axis has to be released with the finger, or the next gesture on the
  // same row inherits a decision made about a different one.
  it('unlocks the axis', () => {
    expect(swipeRelease({ offset: 0, open: false, axis: 'y' }, RAIL).axis).toBe('none');
  });
});
