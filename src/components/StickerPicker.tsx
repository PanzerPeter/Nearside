import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Search, Trash2 } from 'lucide-react';
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
  /** The sticker being dragged, once the pointer has travelled far enough to
   *  mean it. Null while a press is still just a press. */
  const [dragging, setDragging] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pressOrigin = useRef<{ x: number; y: number; id: string } | null>(null);
  /** Suppresses the click that ends a drag: a pointerup after reordering is
   *  still a click on the tile, and without this every drag also sent the
   *  sticker it had just moved. */
  const draggedRef = useRef(false);

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
    holdTimer.current = window.setTimeout(() => setArmed(id), 500);
  }

  function cancelHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

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
    startHold(id);
    if (!canReorder) return;
    pressOrigin.current = { x: e.clientX, y: e.clientY, id };
    draggedRef.current = false;
  }

  function onTilePointerMove(e: React.PointerEvent) {
    const origin = pressOrigin.current;
    if (!origin) return;

    if (!dragging) {
      // A tap wobbles, so a drag only begins once the pointer has really
      // travelled. Crossing that line also cancels the long-press: the two
      // gestures start identically and only one of them can win.
      if (!movedBeyond(origin, { x: e.clientX, y: e.clientY }, 6)) return;
      cancelHold();
      setArmed(null);
      setDragging(origin.id);
      draggedRef.current = true;
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
    const heldId = dragging ?? origin.id;
    if (targetId && targetId !== heldId) drawer.reorder(heldId, targetId);
  }

  function endDrag() {
    cancelHold();
    pressOrigin.current = null;
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

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" onScroll={() => setArmed(null)}>
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
                  className="w-full h-full flex items-center justify-center rounded-field hover:bg-wash active:scale-95 transition"
                  onClick={() => {
                    if (draggedRef.current) {
                      draggedRef.current = false;
                      return;
                    }
                    if (armed === sticker.id) setArmed(null);
                    else onSelect(sticker);
                  }}
                  onPointerDown={(e) => onTilePointerDown(e, sticker.id)}
                  onPointerMove={onTilePointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onPointerLeave={cancelHold}
                  // Only while a drag is live: set unconditionally it would
                  // take scrolling the grid away from the finger.
                  style={dragging ? { touchAction: 'none' } : undefined}
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
                      className="max-w-full max-h-full object-contain"
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
          <p className="px-2 pt-1 text-micro text-faint">{t('stickers.reorderHint')}</p>
        )}
      </div>
    </div>
  );
}
