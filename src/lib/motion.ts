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
