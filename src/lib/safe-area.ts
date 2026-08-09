/**
 * The system-bar insets, in CSS pixels, for the code that has to position
 * something itself.
 *
 * Stylesheets read `--safe-top` and friends directly (see `index.css`, which
 * is where those are defined and why). JavaScript cannot: an unregistered
 * custom property computes to the text it was written as, so reading one back
 * yields the literal `max(env(...), ...)` rather than a number. Measuring a
 * probe element makes the browser resolve it, which is the only way to get the
 * value without registering the properties — and registering them would make
 * a single unparseable value silently collapse every inset in the app to zero.
 */
export function safeAreaInsets(): { top: number; bottom: number } {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;' +
    'padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
  };
  probe.remove();
  return insets;
}
