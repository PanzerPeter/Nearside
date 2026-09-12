import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../hooks/useT';
import { createPortal } from 'react-dom';
import { safeAreaInsets } from '../lib/safe-area';
import { placeMenu, type Placement } from '../lib/menu-placement';
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
  anchorRef: RefObject<HTMLElement | null>;
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
  const t = useT();
  const [pos, setPos] = useState<Placement | null>(null);
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
      setPos(
        placeMenu({
          anchor: anchor.getBoundingClientRect(),
          // offsetWidth, not a rect: the card animates in with a scale, and a
          // transformed rect would measure ~2% small on the frame this runs.
          width: panel.offsetWidth,
          // scrollHeight, not offsetHeight: once a previous pass has capped the
          // card, its box is the cap and measuring it would ratchet the card
          // smaller on every re-place.
          height: panel.scrollHeight,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          // The viewport runs under the status bar and the gesture pill, so the
          // margin that keeps this card on screen has to keep it out from under
          // them too.
          safe: safeAreaInsets(),
          gap: GAP,
          margin: MARGIN,
          align,
          prefer: 'above',
        })
      );
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
    function onScroll(e: Event) {
      if (pickerOpen) return;
      // A card taller than the screen scrolls inside itself; reading a long
      // action list is not leaving it.
      if (panelRef.current?.contains(e.target as Node)) return;
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
      aria-label={t('message.actions')}
      className="fixed z-50 w-max max-w-[calc(100vw-1rem)] rounded-box bg-base-100 border border-hairline shadow-overlay overflow-y-auto animate-message-in"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        maxHeight: pos?.maxHeight,
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
        <ul className="border-t border-hairline py-1">
          {actions.map((action, i) => (
            <li
              key={action.key}
              // A destructive row is fenced off from the ordinary ones rather
              // than merely coloured: colour alone is a weak boundary for a
              // thumb, and it is no boundary at all to anyone who cannot tell
              // the red from the rest.
              className={
                action.danger && i > 0 ? 'mt-1 border-t border-hairline pt-1' : undefined
              }
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  action.onSelect();
                  onClose();
                }}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-body text-left hover:bg-wash transition-colors ${
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
