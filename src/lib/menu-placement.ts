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
}: PlacementInput): Placement {
  const topLimit = margin + safe.top;
  const bottomLimit = viewport.height - margin - safe.bottom;
  const maxHeight = Math.max(0, bottomLimit - topLimit);
  const used = Math.min(height, maxHeight);

  let top = anchor.bottom + gap;
  if (top + used > bottomLimit) top = anchor.top - used - gap;
  if (top < topLimit) top = Math.max(topLimit, Math.min(anchor.top, bottomLimit - used));

  // Right-aligned to the anchor: the `⋯` button sits at a row's right edge, so
  // the card unfolds inwards over the row rather than off the side.
  const left = anchor.right - width;
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
