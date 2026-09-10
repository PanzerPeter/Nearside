import { useCallback, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useSwipeActions } from '../hooks/useSwipeActions';
import { isCoarsePointer } from '../lib/device';
import { useT } from '../hooks/useT';
import { RowMenu, type MenuAnchor } from './RowMenu';

export interface RowAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Destructive actions are red and sit at the end of the rail. */
  destructive?: boolean;
}

interface SwipeRowProps {
  actions: RowAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** One action's width in the rail. Wide enough for a label under the icon,
 *  narrow enough that three of them still leave the row readable: at 72 the
 *  rail took over half a 411dp phone and an opened row showed nothing but its
 *  timestamp, so there was no way to tell which conversation you were about to
 *  delete. */
const ACTION_PX = 64;

/**
 * A list row with actions behind it.
 *
 * Two ways in, deliberately. The swipe is the phone gesture; the `⋯` button and
 * the right-click menu are the same three actions for a mouse and a keyboard.
 * A gesture-only feature would be unreachable on the desktop shell and to
 * anyone who does not use a touchscreen, which is not a trade this app makes
 * anywhere else.
 *
 * The rail is `aria-hidden` and untabbable while closed: an offscreen button
 * that focus can still land on is a trap, and a keyboard user tabbing through
 * the list would fall into three invisible controls per row.
 */
export function SwipeRow({ actions, open, onOpenChange, children }: SwipeRowProps) {
  const t = useT();
  const railWidth = actions.length * ACTION_PX;
  // The rect the card hangs from, in viewport coordinates. Null means closed.
  // Held as a value rather than a ref to the trigger because a right-click has
  // no trigger — the anchor there is the pointer itself.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [coarse] = useState(isCoarsePointer);
  const wrapRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const swipe = useSwipeActions({
    railWidth,
    open,
    onOpenChange,
    enabled: actions.length > 0,
  });

  // Focus goes back where it came from, so dismissing a menu with Escape does
  // not drop a keyboard user at the top of the document.
  const closeMenu = useCallback(() => {
    setAnchor(null);
    moreRef.current?.focus({ preventScroll: true });
  }, []);

  function run(action: RowAction) {
    setAnchor(null);
    onOpenChange(false);
    action.onClick();
  }

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-box"
      onContextMenu={(e) => {
        if (actions.length === 0) return;
        e.preventDefault();
        // A right-click has no trigger element, so the pointer is the anchor:
        // a zero-size rect at the cursor, which `placeMenu` treats exactly as
        // it treats a button's.
        setAnchor({ top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX });
      }}
    >
      <div
        className="absolute inset-y-0 right-0 flex"
        style={{ width: railWidth }}
        aria-hidden={!open}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={() => run(action)}
            style={{ width: ACTION_PX }}
            className={`flex flex-col items-center justify-center gap-1 text-micro font-medium ${
              action.destructive
                ? 'bg-error/15 text-error'
                : 'bg-base-300 text-strong'
            }`}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>

      {/* Opaque: the rail is directly underneath, and a translucent row would
          show its buttons through the text. */}
      <div
        className="relative bg-base-100"
        style={swipe.style}
        {...swipe.handlers}
        // While the rail is open the row itself is the way to close it. Without
        // this, a tap anywhere on an opened row opens the conversation instead
        // — and the rail the user was reading disappears with no way to have
        // undone it.
        onClickCapture={(e) => {
          if (!open) return;
          e.preventDefault();
          e.stopPropagation();
          onOpenChange(false);
        }}
      >
        {children}
      </div>

      {/* The pointer path for everyone not using a finger. Always rendered on a
          fine pointer so it can be reached by tab, not only by hover. */}
      {!coarse && actions.length > 0 && (
        <button
          ref={moreRef}
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            // Measured here, not inside the updater: `currentTarget` is cleared
            // once the handler returns, and a state updater can run after it.
            const rect = e.currentTarget.getBoundingClientRect();
            setAnchor((current) => (current ? null : rect));
          }}
          title={t('chatList.actions')}
          aria-label={t('chatList.actions')}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}

      {/* Outside the clipped box above, in a portal — see `RowMenu`. */}
      <RowMenu
        open={anchor !== null}
        anchor={anchor}
        label={t('chatList.actions')}
        onClose={closeMenu}
        items={actions.map((action) => ({
          key: action.key,
          label: action.label,
          icon: action.icon,
          destructive: action.destructive,
          onClick: () => run(action),
        }))}
      />
    </div>
  );
}
