import { describe, expect, it } from 'vitest';
import { CANCEL_SLIDE_PX, holdOutcome, LOCK_SLIDE_PX } from './hold-record';

describe('holdOutcome', () => {
  it('keeps recording while the finger holds still', () => {
    expect(holdOutcome(0, 0)).toBe('holding');
  });

  // Holding a phone one-handed is not holding it perfectly still.
  it('tolerates the drift of a thumb that has not moved on purpose', () => {
    expect(holdOutcome(-8, -12)).toBe('holding');
  });

  it('arms the discard on a slide away from the button', () => {
    expect(holdOutcome(-CANCEL_SLIDE_PX, 0)).toBe('cancel-armed');
  });

  it('locks on a slide up', () => {
    expect(holdOutcome(0, -LOCK_SLIDE_PX)).toBe('locked');
  });

  // Down and right mean nothing: the composer is at the bottom of the screen
  // and there is nowhere for either to go.
  it('ignores travel downward and to the right', () => {
    expect(holdOutcome(200, 200)).toBe('holding');
  });

  // A diagonal drag past both thresholds must not resolve on the order the
  // branches happen to be written in.
  it('resolves a diagonal to the direction it committed to further', () => {
    expect(holdOutcome(-70, -140)).toBe('locked');
    expect(holdOutcome(-140, -70)).toBe('cancel-armed');
  });

  it('returns to holding when the finger comes back', () => {
    expect(holdOutcome(-LOCK_SLIDE_PX + 1, -LOCK_SLIDE_PX + 1)).toBe('holding');
  });
});
