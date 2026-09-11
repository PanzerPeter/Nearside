import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Search, Trash2 } from 'lucide-react';
import { isCoarsePointer } from '../lib/device';
import { indexAtPoint, movedBeyond } from '../lib/reorder';
import { matchesLabel, STICKER_SOURCE_TYPES, type Sticker } from '../lib/stickers';
import type { StickerDrawer } from '../hooks/useStickers';
import { useT } from '../hooks/useT';

interface StickerPickerProps {
  drawer: StickerDrawer;
  onSelect: (sticker: Sticker) => void;
  onError: (message: string) => void;
}

/**
 * The sticker half of the picker.
 *
 * Sized to fill its parent rather than to a grid of its own, which is the whole
 * reason the tabs replaced a side-by-side panel: a sticker sheet docked beside
 * an emoji sheet leaves one of them empty at any moment, and on a phone it
 * leaves both of them too narrow.
 */
export function StickerPicker({ drawer, onSelect, onError }: StickerPickerProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  // Long-press / right-click arms the delete for one tile. Held as an id rather
  // than a mode so arming a second tile disarms the first.
  const [armed, setArmed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const holdTimer = useRef<number | null>(null);
  /** The sticker being dragged — or, on a touchscreen, picked up and about to
   *  be. Null while a press is still just a press; drives the lifted look. */
  const [dragging, setDragging] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pressOrigin = useRef<{ x: number; y: number; id: string } | null>(null);
  /**
   * The tile being dragged, as a ref.
   *
   * The same thing `dragging` renders, kept beside it because the pointer
   * handlers have to know whether a drag is live *within* the event that
   * starts one, and state set a moment ago in a timer is not readable there.
   */
  const dragIdRef = useRef<string | null>(null);
  /**
   * Whether a touch has picked its tile up.
   *
   * On a touchscreen a press and a drag begin identically to a scroll, and the
   * browser decides which it is at the first movement. So the pick-up is the
   * long press: while it holds, the finger has not moved, no scroll has
   * started, and the touchmove listener below can still refuse one.
   */
  const lifted = useRef(false);
  /** Whether this device is a touchscreen, decided once — a drag begins on
   *  travel with a mouse and on the long press without one. */
  const [coarse] = useState(isCoarsePointer);
  /** Suppresses the click that ends a gesture: a pointerup after a drag or a
   *  long press is still an ordinary click on the tile. Without it a drag also
   *  sent the sticker it had just moved, and a long press armed the delete
   *  button and then dismissed it in the same gesture. */
  const swallowClick = useRef(false);

  // The drawer is owned by ChatRoom and loads nothing until something asks. The
  // popover mounts this component the moment it opens, tab selected or not, so
  // this is the earliest point at which the library is about to be looked at.
  const { activate } = drawer;
  useEffect(() => activate(), [activate]);

  const shown = useMemo(
    () => drawer.stickers.filter((s) => matchesLabel(s.label, query)),
    [drawer.stickers, query]
  );

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    // The file name is the label's default: it is usually what the sticker is,
    // and typing a name for every upload is friction on the one flow that has
    // to stay quick.
    const label = file.name.replace(/\.[^.]+$/, '');
    const error = await drawer.add(file, label);
    if (error) onError(error);
  }

  function startHold(id: string) {
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setArmed(id);
      // The click that follows the release would otherwise dismiss what this
      // just armed, so the delete button never appeared on a phone at all.
      swallowClick.current = true;
      // On a touchscreen the same press is the pick-up. Only when the finger
      // is still on the tile it started on: a press that has already wandered
      // is a scroll.
      if (pressOrigin.current?.id === id) {
        lifted.current = true;
        setDragging(id);
      }
    }, 500);
  }

  function cancelHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  /**
   * Refuse the scroll a lifted tile's movement would otherwise be.
   *
   * Registered natively and non-passive, which is the whole point: React
   * attaches `touchmove` at the root as a passive listener, where
   * `preventDefault` does nothing at all. Without this the first movement
   * after the pick-up scrolls the grid instead, the browser takes the gesture
   * over, the pointer stream is cancelled — and no sticker can be dragged
   * anywhere on a touchscreen, which is every phone the app ships to.
   *
   * `touch-action` cannot do this job: its value is read when the gesture
   * begins, so a tile that only becomes undraggable-by-scroll once a drag is
   * under way has already lost.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (lifted.current && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, []);

  /**
   * Reordering is off while a search is filtering the grid.
   *
   * The tiles on screen are then a subset in their own order, and dropping one
   * between two of them means nothing about where it sits in the library — the
   * only honest answer would be to guess. Clearing the box is the way to
   * reorder, and the placeholder says so.
   */
  const canReorder = query.trim() === '';

  function onTilePointerDown(e: React.PointerEvent, id: string) {
    swallowClick.current = false;
    // Set before the hold timer can read it: the pick-up checks that the press
    // is still on the tile it started on.
    if (canReorder) pressOrigin.current = { x: e.clientX, y: e.clientY, id };
    startHold(id);
  }

  function onTilePointerMove(e: React.PointerEvent) {
    const origin = pressOrigin.current;
    if (!origin) return;
    const travelled = movedBeyond(origin, { x: e.clientX, y: e.clientY }, 6);

    if (!dragIdRef.current) {
      if (coarse) {
        // Until the tile has been picked up, movement is the grid being
        // scrolled — the browser is welcome to it, and the long press the
        // finger has walked away from is over.
        if (!lifted.current) {
          if (travelled) {
            cancelHold();
            pressOrigin.current = null;
          }
          return;
        }
      } else {
        // A tap wobbles, so with a mouse a drag begins once the pointer has
        // really travelled. Crossing that line also cancels the long press:
        // the two gestures start identically and only one can win.
        if (!travelled) return;
        cancelHold();
        setArmed(null);
      }
      dragIdRef.current = origin.id;
      swallowClick.current = true;
      setDragging(origin.id);
      // Captured so the drag survives the pointer leaving the tile it started
      // on — which it does immediately, that being the point.
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }

    const grid = gridRef.current;
    if (!grid) return;
    const tiles = [...grid.children] as HTMLElement[];
    const over = indexAtPoint(
      tiles.map((tile) => tile.getBoundingClientRect()),
      e.clientX,
      e.clientY
    );
    if (over === null) return;
    const targetId = shown[over]?.id;
    const heldId = dragIdRef.current;
    if (targetId && heldId && targetId !== heldId) drawer.reorder(heldId, targetId);
  }

  function endDrag() {
    cancelHold();
    pressOrigin.current = null;
    dragIdRef.current = null;
    lifted.current = false;
    setDragging(null);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 pb-2 shrink-0">
        <label className="flex items-center gap-2 rounded-field bg-base-200/60 px-2.5 h-8">
          <Search className="w-3.5 h-3.5 text-faint shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('stickers.search')}
            className="w-full bg-transparent text-body focus:outline-hidden"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-2 pb-2"
        onScroll={() => setArmed(null)}
      >
        {drawer.loading ? (
          <div className="flex justify-center py-10">
            <span className="loading loading-spinner loading-sm" />
          </div>
        ) : drawer.stickers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 px-4 text-center">
            <p className="text-body text-muted">{t('stickers.none')}</p>
            <p className="text-meta text-faint">{t('stickers.noneHint')}</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-body text-subtle">
            {t('stickers.noMatch', { query })}
          </p>
        ) : (
          <>
          {/* Only when there is nothing typed: a search is a request for a
              particular sticker, and a shelf of unrelated ones above the
              results is the drawer answering a question nobody asked. It also
              needs more than one, because a "recent" row holding the single
              sticker directly below it is two tiles of the same picture. */}
          {!query && drawer.recent.length > 1 && (
            <div className="mb-2">
              <p className="px-0.5 pb-1 text-micro font-semibold uppercase tracking-wider text-subtle">
                {t('stickers.recent')}
              </p>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {drawer.recent.map((sticker) => (
                  <button
                    key={sticker.id}
                    type="button"
                    className="h-12 w-12 shrink-0 rounded-field p-1 transition hover:bg-wash active:scale-95"
                    onClick={() => {
                      drawer.noteUse(sticker);
                      onSelect(sticker);
                    }}
                    title={sticker.label}
                    aria-label={sticker.label}
                  >
                    {drawer.urls[sticker.id] ? (
                      <img
                        src={drawer.urls[sticker.id]}
                        alt=""
                        className="h-full w-full object-contain"
                        draggable={false}
                      />
                    ) : (
                      <span className="block h-full w-full rounded-field bg-base-200" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={gridRef} className="grid grid-cols-4 gap-1.5">
            {shown.map((sticker) => (
              <div
                key={sticker.id}
                className={`relative aspect-square transition-transform ${
                  dragging === sticker.id ? 'scale-110 opacity-80 z-10' : ''
                }`}
              >
                <button
                  type="button"
                  // `select-none` and the callout suppression are what keep the
                  // long press a gesture this app handles: see the image below.
                  className="w-full h-full flex items-center justify-center rounded-field hover:bg-wash active:scale-95 transition select-none [-webkit-touch-callout:none]"
                  onClick={() => {
                    if (swallowClick.current) {
                      swallowClick.current = false;
                      return;
                    }
                    if (armed === sticker.id) setArmed(null);
                    else {
                      drawer.noteUse(sticker);
                      onSelect(sticker);
                    }
                  }}
                  onPointerDown={(e) => onTilePointerDown(e, sticker.id)}
                  onPointerMove={onTilePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onPointerLeave={cancelHold}
                  // Only while a tile is held: set unconditionally it would
                  // take scrolling the grid away from the finger. The touchmove
                  // listener is what actually holds the scroll off mid-gesture
                  // — this keeps the pinch and the fling off the tile as well.
                  style={dragging === sticker.id ? { touchAction: 'none' } : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setArmed(sticker.id);
                  }}
                  title={sticker.label || t('preview.sticker')}
                >
                  {drawer.urls[sticker.id] ? (
                    <img
                      src={drawer.urls[sticker.id]}
                      alt={sticker.label || t('preview.sticker')}
                      // Not a target for anything.
                      //
                      // A long press on an *image* is a gesture Android Chrome
                      // claims for itself: it fires `contextmenu` and then a
                      // `pointercancel` that is not cancelable, so the touch
                      // sequence is dead before the tile can be dragged
                      // anywhere — which is why reordering never worked on a
                      // phone. Preventing the context menu does not give the
                      // gesture back. With the image out of the hit test the
                      // press lands on the button, which has nothing to save
                      // and nothing to select, and the events keep coming.
                      draggable={false}
                      className="max-w-full max-h-full object-contain pointer-events-none select-none"
                    />
                  ) : (
                    // Not a spinner per tile: forty spinners at once is a
                    // flickering grid. A quiet placeholder fills in as each
                    // sticker decrypts.
                    <span className="w-full h-full rounded-field bg-base-content/5" />
                  )}
                </button>
                {armed === sticker.id && (
                  <button
                    type="button"
                    className="absolute -top-1 -right-1 btn btn-error btn-xs btn-circle"
                    onClick={() => {
                      setArmed(null);
                      void drawer.remove(sticker);
                    }}
                    aria-label={t('stickers.deleteOne', {
                      label: sticker.label || t('preview.sticker'),
                    })}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline p-2">
        <input
          ref={fileRef}
          type="file"
          accept={STICKER_SOURCE_TYPES.join(',')}
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files);
            // Cleared so picking the same file twice fires change both times.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm w-full justify-start gap-2"
          onClick={() => fileRef.current?.click()}
          disabled={drawer.full}
        >
          <ImagePlus className="w-4 h-4 text-muted" />
          {drawer.full ? t('stickers.full') : t('stickers.add')}
        </button>
        {/* Dragging is invisible until somebody tries it, and nobody tries a
            gesture they were never told about. Shown only when there is
            something to reorder and nothing filtering the grid. */}
        {canReorder && drawer.stickers.length > 1 && (
          <p className="px-2 pt-1 text-micro text-faint">
            {t(coarse ? 'stickers.reorderHintTouch' : 'stickers.reorderHint')}
          </p>
        )}
      </div>
    </div>
  );
}
