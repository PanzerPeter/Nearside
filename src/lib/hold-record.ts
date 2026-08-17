/**
 * What a finger holding the mic button is asking for.
 *
 * Press-and-hold can only say one thing on its own — "record while I hold" —
 * which caps a voice message at how long somebody can keep a thumb still. The
 * two escapes are directional: sliding away cancels, and sliding up hands the
 * recording over to the UI so the finger can leave.
 *
 * Left and up were previously the same gesture (both cancelled), so this
 * changes what a slide up means. That direction is the one people arrive from
 * other messengers expecting to lock, and cancel keeps the direction the trash
 * can sits in.
 */

/** How far up the finger must travel to hand the recording over. */
export const LOCK_SLIDE_PX = 60;

/** …and how far away from the button to arm the discard. Roughly a thumb's
 *  width in both cases: far enough not to fire on the drift of holding still. */
export const CANCEL_SLIDE_PX = 60;

export type HoldOutcome = 'holding' | 'cancel-armed' | 'locked';

/**
 * Classify a hold, given how far the finger has moved from where it started.
 *
 * `dx`/`dy` are current minus origin in CSS pixels, so up and left are
 * negative. A diagonal drag resolves to whichever direction it has committed to
 * further, rather than to whichever branch happens to be tested first.
 */
export function holdOutcome(dx: number, dy: number): HoldOutcome {
  const up = -dy;
  const away = -dx;
  const lockable = up >= LOCK_SLIDE_PX;
  const cancellable = away >= CANCEL_SLIDE_PX;
  if (lockable && cancellable) return up >= away ? 'locked' : 'cancel-armed';
  if (lockable) return 'locked';
  if (cancellable) return 'cancel-armed';
  return 'holding';
}
