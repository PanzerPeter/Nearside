// When a scroll should take an anchored popover down with it.
//
// Extracted from `EmojiPopover` so the rule is testable without a document:
// the version that lived in the component closed on *any* scroll anywhere on
// the page, and the message list scrolls on its own every time the peer sends
// a message or starts typing — so the picker shut under the finger of somebody
// who had done nothing.

/** The slice of `Node` this needs. A DOM node satisfies it; so does a stand-in
 *  in a test, which is the point of naming it. */
export interface ContainerNode {
  contains(other: ContainerNode | null): boolean;
}

interface ScrollDismissal {
  /** What the scroll event came from — a scrollable element, or the document. */
  target: ContainerNode | null;
  /** The popover's own panel. */
  panel: ContainerNode | null;
  /** The button the popover is positioned against. */
  anchor: ContainerNode | null;
}

/**
 * A popover is placed against its trigger's rect, so the only scroll that can
 * strand it is one that *moves the trigger* — the document, or a scrollable
 * ancestor of the button. A sibling scroller (the message thread, under a
 * composer that does not move with it) leaves the trigger exactly where the
 * popover was told it was.
 */
export function dismissesOnScroll({ target, panel, anchor }: ScrollDismissal): boolean {
  if (!target) return false;
  // Scrolling the picker's own emoji list is browsing, not leaving.
  if (panel?.contains(target)) return false;
  // No trigger left to hang from: nothing keeps the position honest.
  if (!anchor) return true;
  return target.contains(anchor);
}
