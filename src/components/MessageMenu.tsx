import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { safeAreaInsets } from '../lib/safe-area';
import { ReactionBar } from './ReactionBar';

export interface MessageMenuAction {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** Renders in the error colour — for destructive actions. */
  danger?: boolean;
}

interface MessageMenuProps {
  open: boolean;
  /** The bubble this menu belongs to; placement is measured from its rect. */
  anchorRef: RefObject<HTMLElement>;
  /** Which edge of the bubble the card lines up with — own messages sit on
   *  the right of the thread, the friend's on the left. */
  align: 'start' | 'end';
  actions: MessageMenuAction[];
  onReact: (emoji: string) => void;
  onClose: () => void;
}

/** Breathing room between the card and its bubble, and between the card and
 *  the viewport edges. */
const GAP = 8;
const MARGIN = 8;

interface Pos {
  top: number;
  left: number;
}

/**
 * Everything you can do to one message, in a single floating card: quick
 * reactions on top, then reply/copy/edit/delete.
 *
 * One card rather than two independently positioned layers. A reaction bar
 * above the bubble and a dropdown unfolding from a button beside it are
 * revealed by the same tap into the same strip of space, so they overlap and
 * the dropdown's first items sit underneath, unclickable. Merging removes the
 * collision by construction instead of by tuning offsets until they miss.
 *
 * Rendered in a body-level portal with viewport-aware placement, because the
 * message list clips both axes and an in-flow card would be cut off at the top
 * of the thread and beside a wide bubble.
 */
export function MessageMenu({
  open,
  anchorRef,
  align,
  actions,
  onReact,
  onClose,
}: MessageMenuProps) {
  const [pos, setPos] = useState<Pos | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The emoji picker opens in its own portal, outside this card. While it is
  // up, a click in it is "outside" by DOM containment but very much inside as
  // far as the user is concerned — dismissing on it would close the card out
  // from under the picker.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Placement needs the card's own measured size, so it runs after the first
  // paint of an open menu; until `pos` exists the card renders hidden rather
  // than flashing in the top-left corner.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      // The picker unmounts with the card; without this its flag would stay
      // raised and suppress the next menu's outside-dismiss.
      setPickerOpen(false);
      return;
    }

    function place() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const a = anchor.getBoundingClientRect();
      // offset*, not a rect: the card animates in with a scale, and a
      // transformed rect would measure ~2% small on the frame this runs.
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // The viewport runs under the status bar and the gesture pill, so the
      // margin that keeps this card on screen has to keep it out from under
      // them too — otherwise a tall menu clamps to a top edge occupied by the
      // clock, or a bottom edge occupied by the pill.
      const safe = safeAreaInsets();
      const topLimit = MARGIN + safe.top;
      const bottomLimit = vh - MARGIN - safe.bottom;

      // Above the bubble by preference — that is where the thumb isn't, and
      // it leaves the message itself visible. Below when there isn't room,
      // clamped into the viewport when there is room for neither.
      let top = a.top - height - GAP;
      if (top < topLimit) top = a.bottom + GAP;
      if (top + height > bottomLimit) top = Math.max(topLimit, bottomLimit - height);

      const left = align === 'end' ? a.right - width : a.left;
      setPos({ top, left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - width - MARGIN)) });
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align, anchorRef, actions.length]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: PointerEvent) {
      if (pickerOpen) return;
      const target = e.target as Node;
      // The anchor is excluded so the tap that closes an open menu is handled
      // once, by the bubble's own toggle, instead of also being seen here.
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    // The card is anchored to a bubble in a scrolling list; rather than chase
    // the anchor, scrolling dismisses. Ignored while the picker is open,
    // since browsing emoji scrolls the picker's own list.
    function onScroll() {
      if (pickerOpen) return;
      onClose();
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, pickerOpen, anchorRef, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label="Message actions"
      className="fixed z-50 w-max max-w-[calc(100vw-1rem)] rounded-2xl bg-base-100 border border-base-content/10 shadow-overlay overflow-hidden animate-message-in"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <ReactionBar
        onReact={(emoji) => {
          onReact(emoji);
          onClose();
        }}
        onPickerOpenChange={setPickerOpen}
      />
      {actions.length > 0 && (
        <ul className="border-t border-base-content/10 py-1">
          {actions.map((action) => (
            <li key={action.key}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  action.onSelect();
                  onClose();
                }}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm text-left hover:bg-base-content/10 transition-colors ${
                  action.danger ? 'text-error' : ''
                }`}
              >
                {action.icon}
                {action.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body
  );
}
