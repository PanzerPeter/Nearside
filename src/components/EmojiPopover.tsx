import {
  RefObject,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const EmojiPicker = lazy(() => import('./EmojiPicker'));

interface EmojiPopoverProps {
  open: boolean;
  /** The button that toggles the popover; positioning anchors to its rect. */
  anchorRef: RefObject<HTMLElement>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

// emoji-mart's default panel size. Width flexes down via `dynamicWidth`.
const PICKER_W = 352;
const PICKER_H = 435;
const MARGIN = 8;

interface Pos {
  top: number;
  left: number;
  width: number;
}

/**
 * Renders the emoji picker in a body-level portal with viewport-aware
 * placement: it flips above/below the trigger based on available space and
 * clamps horizontally so it never spills off a narrow (phone) screen. This
 * avoids the picker being clipped by the scrollable message list.
 */
export function EmojiPopover({ open, anchorRef, onSelect, onClose }: EmojiPopoverProps) {
  const [pos, setPos] = useState<Pos | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;

    function place() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(PICKER_W, vw - MARGIN * 2);
      const height = Math.min(PICKER_H, vh - MARGIN * 2);

      // Prefer opening above the trigger; fall back below, then clamp.
      let top: number;
      if (r.top >= height + MARGIN) top = r.top - height - MARGIN;
      else if (vh - r.bottom >= height + MARGIN) top = r.bottom + MARGIN;
      else top = Math.max(MARGIN, vh - height - MARGIN);

      // Centre on the trigger, then keep fully on-screen.
      let left = r.left + r.width / 2 - width / 2;
      left = Math.min(Math.max(MARGIN, left), vw - width - MARGIN);

      setPos({ top, left, width });
    }

    // Dismiss when the *page* scrolls (so the picker can't float away from its
    // trigger) — but ignore scrolls that originate inside the picker's own
    // emoji list, which would otherwise close it the moment you browse emojis.
    function onScroll(e: Event) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, anchorRef, onClose]);

  // emoji-mart fires this for any click it considers "outside" its root. Ignore
  // clicks on the trigger button — otherwise the click that opens the picker
  // (once emoji-mart is already loaded and mounts synchronously) is seen as an
  // outside click and closes it immediately, so it only ever opened once.
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    },
    [anchorRef, onClose]
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-50"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      onClick={(e) => e.stopPropagation()}
    >
      <Suspense fallback={null}>
        <EmojiPicker onSelect={onSelect} onClickOutside={handleClickOutside} />
      </Suspense>
    </div>,
    document.body
  );
}
