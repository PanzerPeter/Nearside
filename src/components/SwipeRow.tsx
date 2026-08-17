import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useSwipeActions } from '../hooks/useSwipeActions';
import { isCoarsePointer } from '../lib/device';

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
  const railWidth = actions.length * ACTION_PX;
  const [menuOpen, setMenuOpen] = useState(false);
  const [coarse] = useState(isCoarsePointer);
  const wrapRef = useRef<HTMLDivElement>(null);

  const swipe = useSwipeActions({
    railWidth,
    open,
    onOpenChange,
    enabled: actions.length > 0,
  });

  // A menu left open behind a scrolled list, or behind the chat that a click
  // just opened, is a popover nobody asked to keep.
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function run(action: RowAction) {
    setMenuOpen(false);
    onOpenChange(false);
    action.onClick();
  }

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-xl"
      onContextMenu={(e) => {
        if (actions.length === 0) return;
        e.preventDefault();
        setMenuOpen(true);
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
            className={`flex flex-col items-center justify-center gap-1 text-[0.65rem] font-medium ${
              action.destructive
                ? 'bg-error/15 text-error'
                : 'bg-base-300 text-base-content/80'
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
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          title="Chat actions"
          aria-label="Chat actions"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      )}

      {menuOpen && (
        <div className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-lg border border-base-content/10 bg-base-100 py-1 shadow-lg">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => run(action)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-base-200 ${
                action.destructive ? 'text-error' : ''
              }`}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
