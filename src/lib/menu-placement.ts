// Where a floating card goes, given what it hangs from and how much room there
// is. Pure, so the rules can be checked without a viewport — the component that
// used to hold this arithmetic could only be verified by opening the app on a
// short screen and looking.

/** A point or a rect the card hangs from, in viewport coordinates.
 *  `getBoundingClientRect()` satisfies it, and so does a bare pointer position,
 *  which is all a right-click has. */
export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlacementInput {
  anchor: MenuAnchor;
  /** The card's own measured size. */
  width: number;
  height: number;
  viewport: { width: number; height: number };
  /** System-bar insets, so a card never lands under the clock or the gesture
   *  pill. */
  safe: { top: number; bottom: number };
  /** Space between the card and its anchor. */
  gap: number;
  /** Space between the card and the viewport edges. */
  margin: number;
  /** Which edge of the anchor the card lines up with. `end` is the `⋯` button
   *  at a row's right edge; `start` is a message bubble sitting on the left of
   *  the thread, where a right-aligned card would point away from it. */
  align?: 'start' | 'end';
  /** Which side of the anchor to try first. A row menu wants `below` — that is
   *  where the rest of the list is, so the card covers rows the user is not
   *  acting on. A message menu wants `above`: that is where the thumb isn't,
   *  and it leaves the message itself visible. Either flips when it won't fit. */
  prefer?: 'above' | 'below';
}

export interface Placement {
  top: number;
  left: number;
  /** What the card is allowed to grow to before it must scroll its own
   *  contents. Always the space between the two limits, so a card with more
   *  items than the screen has room for scrolls instead of overhanging. */
  maxHeight: number;
}

/**
 * Below the anchor by preference — that is where the rest of the list is, so
 * the card covers rows the user is not acting on. Above when the anchor sits
 * near the foot of the screen.
 *
 * A card taller than the space between the system bars cannot be placed at all,
 * and clamping one is how a menu ends up with its last item off-screen — an
 * action that exists and cannot be reached. So the card is given a `maxHeight`
 * and scrolls inside it, and every decision below is made against the height it
 * will actually render at rather than the height it asked for.
 */
export function placeMenu({
  anchor,
  width,
  height,
  viewport,
  safe,
  gap,
  margin,
  align = 'end',
  prefer = 'below',
}: PlacementInput): Placement {
  const topLimit = margin + safe.top;
  const bottomLimit = viewport.height - margin - safe.bottom;
  const maxHeight = Math.max(0, bottomLimit - topLimit);
  const used = Math.min(height, maxHeight);

  const above = anchor.top - used - gap;
  const below = anchor.bottom + gap;
  const fitsAbove = above >= topLimit;
  const fitsBelow = below + used <= bottomLimit;

  // Neither side has room for the card even at its capped height, which only
  // happens on a very short screen. Sit it as close to the anchor as the limits
  // allow rather than hanging off one of them.
  let top = Math.max(topLimit, Math.min(anchor.top, bottomLimit - used));
  if (prefer === 'above') {
    if (fitsAbove) top = above;
    else if (fitsBelow) top = below;
  } else {
    if (fitsBelow) top = below;
    else if (fitsAbove) top = above;
  }

  const left = align === 'start' ? anchor.left : anchor.right - width;
  return {
    top,
    left: Math.min(Math.max(margin, left), Math.max(margin, viewport.width - width - margin)),
    maxHeight,
  };
}

/**
 * Which item the arrow keys move to.
 *
 * `-1` is "the menu has focus, no item does" — where a pointer-opened menu
 * starts, so that opening one does not immediately put a destructive action
 * under the keyboard. Both arrows wrap, which is what a menu does and a list
 * does not.
 */
export function nextMenuIndex(
  current: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
  count: number
): number {
  if (count === 0) return -1;
  const last = count - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'ArrowDown') return current >= last ? 0 : current + 1;
  return current <= 0 ? last : current - 1;
}
