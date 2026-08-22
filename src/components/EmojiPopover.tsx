import {
  ReactNode,
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
import { dismissesOnScroll } from '../lib/popover-dismiss';

const EmojiPicker = lazy(() => import('./EmojiPicker'));

interface EmojiPopoverProps {
  open: boolean;
  /** The button that toggles the popover; positioning anchors to its rect. */
  anchorRef: RefObject<HTMLElement>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /**
   * The sticker half. Passed only by the composer.
   *
   * Absent everywhere else on purpose — the reaction picker uses this same
   * popover, and a reaction is a single emoji character stored on a row. A
   * sticker is not one, so offering the tab there would be offering something
   * that cannot be picked.
   */
  stickers?: ReactNode;
}

/** The two halves, when there are two. */
type Tab = 'emoji' | 'stickers';

// emoji-mart's default panel size, widened a little: the ten category tabs
// divide this width between them, so every pixel here is a third of a pixel of
// air around each icon. Width flexes down via `dynamicWidth`.
const PICKER_W = 384;
const PICKER_H = 435;
const MARGIN = 8;

interface Pos {
  top: number;
  left: number;
  width: number;
  /** Kept as well as the width because the tabbed layout has to pin its own
   *  height: the emoji panel sizes itself, and a container that merely wrapped
   *  it would jump when the sticker grid took its place. */
  height: number;
}

/**
 * Renders the emoji picker in a body-level portal with viewport-aware
 * placement: it flips above/below the trigger based on available space and
 * clamps horizontally so it never spills off a narrow (phone) screen. This
 * avoids the picker being clipped by the scrollable message list.
 */
export function EmojiPopover({
  open,
  anchorRef,
  onSelect,
  onClose,
  stickers,
}: EmojiPopoverProps) {
  const [pos, setPos] = useState<Pos | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Reset on every open rather than remembered across them. The emoji half is
  // what the button promises, and reopening into a sticker grid because that is
  // where you were ten minutes ago reads as the wrong panel.
  const [tab, setTab] = useState<Tab>('emoji');
  useEffect(() => {
    if (open) setTab('emoji');
  }, [open]);

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

      setPos({ top, left, width, height });
    }

    // Dismiss only when the scroll actually moves the trigger — see
    // `dismissesOnScroll`. Closing on any scroll anywhere meant the message
    // thread's own auto-scroll shut the picker every time the peer sent a
    // message or started typing.
    function onScroll(e: Event) {
      const target = e.target as Node | null;
      if (
        dismissesOnScroll({
          target,
          panel: panelRef.current,
          anchor: anchorRef.current,
        })
      ) {
        onClose();
      }
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
      {stickers ? (
        // One panel, two halves, switched by a control the popover owns —
        // never two panels side by side. A split sheet leaves whichever half
        // you are not using as dead space, which on a phone is half the width
        // of the only picker there is.
        //
        // The height is fixed to the emoji panel's so the popover does not
        // resize under the finger when the tab changes.
        <div
          className="flex flex-col rounded-lg bg-base-100 border border-base-content/10 shadow-modal overflow-hidden"
          style={{ height: pos.height }}
        >
          <div role="tablist" className="flex shrink-0 gap-1 p-2 pb-1.5">
            {(['emoji', 'stickers'] as const).map((name) => (
              <button
                key={name}
                role="tab"
                type="button"
                aria-selected={tab === name}
                className={`flex-1 h-7 rounded-md text-xs font-medium capitalize transition-colors ${
                  tab === name
                    ? 'bg-base-content/10 text-base-content'
                    : 'text-base-content/50 hover:text-base-content/80'
                }`}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {/* Both halves stay mounted, and the inactive one is hidden rather
              than unmounted: the sticker grid holds decrypted object URLs and
              a scroll position, and remounting it on every tab switch would
              rebuild both. */}
          <div className={`emoji-fill flex-1 min-h-0 ${tab === 'emoji' ? '' : 'hidden'}`}>
            <Suspense fallback={null}>
              <EmojiPicker onSelect={onSelect} onClickOutside={handleClickOutside} />
            </Suspense>
          </div>
          <div className={`flex-1 min-h-0 ${tab === 'stickers' ? '' : 'hidden'}`}>{stickers}</div>
        </div>
      ) : (
        <Suspense fallback={null}>
          <EmojiPicker onSelect={onSelect} onClickOutside={handleClickOutside} />
        </Suspense>
      )}
    </div>,
    document.body
  );
}
