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
 *  motion — so a caller can schedule cleanup with one number either way.
 *
 *  Deliberately not affected by the in-app "Reduce motion" switch: that switch
 *  chooses between two sets of animations, and the restrained set still runs
 *  the seal sweep. Only the OS setting means "no animation at all". */
export function motionDuration(token: MotionToken): number {
  return prefersReducedMotion() ? 0 : MOTION[token].duration;
}

// ---------------------------------------------------------------------------
// The in-app preference
//
// Two tiers of animation ship, not an on/off switch. Off (the default) is the
// expressive set — bubbles that spring in from their own corner, a seal that
// glows, sheets that rise. On is the restrained set the app had before it:
// short fades and slides, nothing that overshoots or loops.
//
// The OS accessibility setting is a third, stricter state and always wins: it
// means "no animation", which neither tier is, so it collapses to `reduced`
// here *and* is caught again by the `prefers-reduced-motion` block in
// index.css. Belt and braces, because the expressive set contains a few
// looping decorations that a duration override alone would leave frozen
// mid-cycle rather than removed.

const REDUCED_KEY = 'nearside.motion.reduced';

/** Whether the user asked, in settings, for the restrained animation set.
 *  Off by default — a fresh install gets the expressive one. */
export function isMotionReduced(): boolean {
  try {
    return localStorage.getItem(REDUCED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the choice and repaint against it. Takes effect immediately: every
 *  expressive rule hangs off one attribute, so nothing needs remounting. */
export function setMotionReduced(reduced: boolean): void {
  try {
    localStorage.setItem(REDUCED_KEY, reduced ? '1' : '0');
  } catch {
    /* ignore storage failures — the attribute below still applies for now */
  }
  applyMotionPreference();
}

/** Whether the expressive set should be running: neither tier of "calm down"
 *  is in force. */
export function expressiveMotion(): boolean {
  return !isMotionReduced() && !prefersReducedMotion();
}

/**
 * Stamp `data-motion` on `<html>`. Every expressive rule in `index.css` is
 * scoped to `:root[data-motion='expressive']`, so the attribute being absent —
 * before this runs, or if it never does — yields the restrained set rather
 * than a half-applied expressive one.
 */
export function applyMotionPreference(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute(
    'data-motion',
    expressiveMotion() ? 'expressive' : 'reduced'
  );
}

/**
 * Call once, before the first render, so the opening frame is already in the
 * right tier. Also follows the OS setting for the rest of the session: Android
 * exposes "remove animations" as a quick toggle, and a user who reaches for it
 * mid-conversation means now, not next launch.
 */
export function initMotionPreference(): void {
  applyMotionPreference();
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  window
    .matchMedia('(prefers-reduced-motion: reduce)')
    .addEventListener('change', applyMotionPreference);
}
