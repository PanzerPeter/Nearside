import { useMemo, useRef, useState } from 'react';
import { ImagePlus, Search, Trash2 } from 'lucide-react';
import { matchesLabel, STICKER_SOURCE_TYPES, type Sticker } from '../lib/stickers';
import type { StickerDrawer } from '../hooks/useStickers';

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
  const [query, setQuery] = useState('');
  // Long-press / right-click arms the delete for one tile. Held as an id rather
  // than a mode so arming a second tile disarms the first.
  const [armed, setArmed] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const holdTimer = useRef<number | null>(null);

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

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 pb-2 shrink-0">
        <label className="flex items-center gap-2 rounded-lg bg-base-200/60 px-2.5 h-8">
          <Search className="w-3.5 h-3.5 text-base-content/40 shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stickers"
            className="w-full bg-transparent text-sm focus:outline-none"
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
            <p className="text-sm text-base-content/60">No stickers yet.</p>
            <p className="text-xs text-base-content/40">
              Add a picture and it stays sealed to your account — nobody else can see your
              collection, including us.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-base-content/50">
            Nothing matches &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {shown.map((sticker) => (
              <div key={sticker.id} className="relative aspect-square">
                <button
                  type="button"
                  className="w-full h-full flex items-center justify-center rounded-lg hover:bg-base-content/5 active:scale-95 transition"
                  onClick={() => (armed === sticker.id ? setArmed(null) : onSelect(sticker))}
                  onPointerDown={() => startHold(sticker.id)}
                  onPointerUp={cancelHold}
                  onPointerLeave={cancelHold}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setArmed(sticker.id);
                  }}
                  title={sticker.label || 'Sticker'}
                >
                  {drawer.urls[sticker.id] ? (
                    <img
                      src={drawer.urls[sticker.id]}
                      alt={sticker.label || 'sticker'}
                      className="max-w-full max-h-full object-contain"
                    />
                  ) : (
                    // Not a spinner per tile: forty spinners at once is a
                    // flickering grid. A quiet placeholder fills in as each
                    // sticker decrypts.
                    <span className="w-full h-full rounded-lg bg-base-content/5" />
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
                    aria-label={`Delete ${sticker.label || 'this sticker'}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-base-content/5 p-2">
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
          <ImagePlus className="w-4 h-4 text-base-content/60" />
          {drawer.full ? 'Sticker library is full' : 'Add a sticker'}
        </button>
      </div>
    </div>
  );
}
