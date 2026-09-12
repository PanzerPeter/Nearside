import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { safeAreaInsets } from '../lib/safe-area';
import { nextMenuIndex, placeMenu, type MenuAnchor, type Placement } from '../lib/menu-placement';

export interface RowMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Destructive items are red and sit at the end. */
  destructive?: boolean;
}

interface RowMenuProps {
  open: boolean;
  /** Where the menu was summoned from, in viewport coordinates. */
  anchor: MenuAnchor | null;
  items: RowMenuItem[];
  label: string;
  onClose: () => void;
}

/** Breathing room between the card and its anchor, and between the card and
 *  the viewport edges. */
const GAP = 4;
const MARGIN = 8;

/**
 * The action menu for one list row, in a body-level portal.
 *
 * A portal rather than an absolutely-positioned child, because the row it
 * belongs to cannot host it: `SwipeRow` is `overflow-hidden` so the swipe rail
 * stays hidden behind the row, and the list above it is `overflow-y-auto`. A
 * three-item card is taller than the ~56px row that summoned it, so an in-flow
 * card had its first and last items sliced off by the row's own clip — the menu
 * was legible only in the middle. `MessageMenu` had already solved exactly this
 * for message bubbles; this is the same treatment for list rows rather than a
 * second mechanism beside it.
 *
 * Placement is measured rather than guessed, and the arithmetic lives in
 * `lib/menu-placement.ts` so the rules can be tested without a viewport.
 */
export function RowMenu({ open, anchor, items, label, onClose }: RowMenuProps) {
  const [pos, setPos] = useState<Placement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Which item the arrow keys are on. -1 is "the menu has focus but no item
  // yet", which is where a pointer-opened menu starts: moving focus onto an
  // item immediately would put a destructive action under the keyboard.
  const [active, setActive] = useState(-1);

  // Placement needs the card's own measured size, so it runs after the first
  // paint; until `pos` exists the card renders hidden rather than flashing in
  // the corner.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setActive(-1);
      return;
    }

    function place() {
      const panel = panelRef.current;
      if (!panel || !anchor) return;
      setPos(
        placeMenu({
          anchor,
          width: panel.offsetWidth,
          // scrollHeight, not offsetHeight: once a previous pass has capped the
          // card, its box is the cap and measuring it would ratchet the card
          // smaller on every re-place.
          height: panel.scrollHeight,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          safe: safeAreaInsets(),
          gap: GAP,
          margin: MARGIN,
        })
      );
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, items.length]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    // The card is anchored to a row in a scrolling list; rather than chase the
    // anchor, scrolling dismisses. The card's own scroll is excluded — reading
    // a long menu is not leaving it.
    function onScroll(e: Event) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, onClose]);

  // Focus follows `active` so a screen reader announces the item the arrow keys
  // landed on. The panel itself takes focus first, which is what makes Escape
  // and the arrows reach this card rather than the page behind it.
  useEffect(() => {
    if (!open || !pos) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (active < 0) {
      panel.focus({ preventScroll: true });
      return;
    }
    const items = panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[active]?.focus({ preventScroll: true });
  }, [open, pos, active]);

  if (!open || !anchor) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      // Stopped so a menu open over a full-screen view closes the menu only —
      // otherwise one press dismisses both, the same way `useMobileBackClose`
      // guards against one back press closing two things.
      e.stopPropagation();
      onClose();
      return;
    }
    // Tab out of a menu closes it. Trapping focus inside a three-item row card
    // would be a cage; letting focus leave silently would strand the card over
    // a list the user has moved on from.
    if (e.key === 'Tab') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive((i) => nextMenuIndex(i, e.key as 'ArrowDown', items.length));
    }
  }

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed z-50 w-max max-w-[calc(100vw-1rem)] overflow-y-auto rounded-field border border-hairline bg-base-100 py-1 shadow-overlay outline-none"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => item.onClick()}
          className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-meta hover:bg-base-200 focus-visible:bg-base-200 outline-none ${
            item.destructive ? 'text-error' : ''
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}
