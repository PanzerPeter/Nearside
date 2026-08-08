// CSS's `@media (prefers-reduced-motion: reduce)` cannot reach a `behavior`
// argument passed explicitly to `Element.scrollIntoView()` — per spec, an
// explicit JS-requested smooth scroll always wins over the CSS media query.
// Call sites that animate via `scrollIntoView` must check this directly and
// fall back to `'auto'` themselves.

/**
 * Whether the user has asked the OS for reduced motion. Read fresh on every
 * call (never cached) so a mid-session toggle of the OS setting is honoured
 * on the next scroll, and guarded against environments with no `window` or
 * no `matchMedia` (the Vitest environment is `node`) so it can never throw.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The app's four timings, in one place, so a modal, a message entrance and the
 * seal sweep stop each guessing at their own. Mirrored into CSS custom
 * properties in `index.css`; changing a value here means changing it there.
 */
export const MOTION = {
  /** Something arriving. Decelerating, so it settles rather than stops. */
  enter: { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  /** Something leaving. Faster than it arrived — a slow exit reads as lag. */
  exit: { duration: 120, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  /** Drawing attention to something already on screen. Slight overshoot. */
  emphasis: { duration: 240, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  /** The one-shot sweep marking a message being sealed. Long enough to read
   *  as deliberate, short enough not to delay the next thing typed. */
  seal: { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
} as const;

export type MotionToken = keyof typeof MOTION;

/** A token's duration in milliseconds, or zero when the OS asked for reduced
 *  motion — so a caller can schedule cleanup with one number either way. */
export function motionDuration(token: MotionToken): number {
  return prefersReducedMotion() ? 0 : MOTION[token].duration;
}
