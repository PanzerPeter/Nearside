import { useMemo, useRef, useState } from 'react';
import {
  Apple,
  Car,
  Clock,
  Flag,
  Heart,
  Lightbulb,
  PawPrint,
  Search,
  Smile,
  Volleyball,
  type LucideIcon,
} from 'lucide-react';
import {
  EMOJIS,
  categoriesFor,
  nativeFor,
  recentEmojiIds,
  recordEmojiUse,
  searchEmoji,
  storeSkinTone,
  storedSkinTone,
  type EmojiEntry,
  type SkinTone,
} from '../lib/emoji-index';
import { useT } from '../hooks/useT';
import type { MessageKey } from '../lib/i18n';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

const CATEGORY: Record<string, { icon: LucideIcon; label: MessageKey }> = {
  recent: { icon: Clock, label: 'emoji.recent' },
  people: { icon: Smile, label: 'emoji.people' },
  nature: { icon: PawPrint, label: 'emoji.nature' },
  foods: { icon: Apple, label: 'emoji.foods' },
  activity: { icon: Volleyball, label: 'emoji.activity' },
  places: { icon: Car, label: 'emoji.places' },
  objects: { icon: Lightbulb, label: 'emoji.objects' },
  symbols: { icon: Heart, label: 'emoji.symbols' },
  flags: { icon: Flag, label: 'emoji.flags' },
};

/** The newest emoji of each version, newest first: the first one this device
 *  draws as a single colour glyph is the version it supports. */
const PROBES: [number, string][] = [
  [15, '🫨'],
  [14, '🫠'],
  [13.1, '😶‍🌫️'],
  [13, '🥸'],
  [12.1, '🧑‍🦰'],
  [12, '🥱'],
  [11, '🥰'],
  [5, '🤩'],
  [4, '👱‍♀️'],
  [3, '🤣'],
  [2, '👋🏻'],
];

/**
 * Whether the system font draws `emoji` as one colour glyph.
 *
 * Drawn twice, in red and in blue: a colour glyph ignores `fillStyle` and comes
 * out identical, a missing one is a monochrome box that takes the fill. A ZWJ
 * sequence the font cannot join renders as its parts side by side, which is
 * what the width check catches. The method is is-emoji-supported's, which is
 * what emoji-mart ran.
 */
function drawable(ctx: CanvasRenderingContext2D, emoji: string): boolean {
  const W = 20;
  const H = 25;
  ctx.clearRect(0, 0, W * 2, H);
  ctx.fillStyle = '#f00';
  ctx.fillText(emoji, 0, 22);
  ctx.fillStyle = '#00f';
  ctx.fillText(emoji, W, 22);
  const a = ctx.getImageData(0, 0, W, H).data;
  let i = 0;
  while (i < a.length && !a[i + 3]) i += 4;
  if (i >= a.length) return false;
  const b = ctx.getImageData(W + ((i / 4) % W), Math.floor(i / 4 / W), 1, 1).data;
  if (a[i] !== b[0] || a[i + 2] !== b[2]) return false;
  return ctx.measureText(emoji).width < W;
}

let support: { version: number; flags: boolean } | null = null;
function deviceSupport() {
  if (support) return support;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return (support = { version: Infinity, flags: true });
  ctx.canvas.width = 40;
  ctx.canvas.height = 25;
  ctx.font = '12px Arial, sans-serif';
  ctx.textBaseline = 'top';
  const version = PROBES.find(([, e]) => drawable(ctx, e))?.[0] ?? 1;
  return (support = { version, flags: drawable(ctx, '🇨🇦') });
}

const TONES: SkinTone[] = [1, 2, 3, 4, 5, 6];

/**
 * Our own grid over `@emoji-mart/data`. It is ordinary DOM in the app's own
 * theme — no shadow root, no hand-mirrored colour triples — and its only state
 * worth keeping (recents, tone) lives in `lib/emoji-index.ts`.
 */
export default function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(storedSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  // Read once per open: a row that reshuffles under the finger makes the
  // next tap land on a different emoji. The new order shows next time.
  const [recents] = useState(recentEmojiIds);
  const [active, setActive] = useState('recent');
  const listRef = useRef<HTMLDivElement>(null);

  const { version, flags } = deviceSupport();
  const categories = useMemo(() => categoriesFor(version, flags), [version, flags]);
  const recent = recents.map((id) => EMOJIS[id]).filter((e) => e.version <= version);
  const sections = [{ id: 'recent', emojis: recent }, ...categories];
  const results = useMemo(
    () => (query.trim() ? searchEmoji(query, categories.flatMap((c) => c.emojis)) : null),
    [query, categories]
  );

  function pick(e: EmojiEntry) {
    onSelect(nativeFor(e, tone));
    recordEmojiUse(e.id);
  }

  function jump(id: string) {
    const list = listRef.current;
    const section = list?.querySelector<HTMLElement>(`[data-cat="${id}"]`);
    if (list && section) list.scrollTop = section.offsetTop;
    setActive(id);
  }

  function onScroll() {
    const list = listRef.current;
    if (!list) return;
    let current = 'recent';
    for (const el of list.querySelectorAll<HTMLElement>('[data-cat]')) {
      if (el.offsetTop <= list.scrollTop + 4) current = el.dataset.cat!;
    }
    if (current !== active) setActive(current);
  }

  const grid = (emojis: EmojiEntry[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))]">
      {emojis.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => pick(e)}
          aria-label={e.name}
          className="h-10 flex items-center justify-center rounded-field text-2xl leading-none hover:bg-wash active:scale-90 transition-transform"
        >
          {nativeFor(e, tone)}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-2 pb-1.5 shrink-0">
        {toneOpen ? (
          <div className="flex flex-1 justify-between h-8" role="radiogroup" aria-label={t('emoji.skinTone')}>
            {TONES.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={n === tone}
                className={`w-8 h-8 rounded-field text-xl ${n === tone ? 'bg-base-content/10' : 'hover:bg-wash'}`}
                onClick={() => {
                  setTone(n);
                  storeSkinTone(n);
                  setToneOpen(false);
                }}
              >
                {nativeFor(EMOJIS.wave, n)}
              </button>
            ))}
          </div>
        ) : (
          <label className="flex flex-1 items-center gap-2 rounded-field bg-base-200/60 px-2.5 h-8">
            <Search className="w-3.5 h-3.5 text-faint shrink-0" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('emoji.search')}
              className="w-full bg-transparent text-body focus:outline-hidden"
            />
          </label>
        )}
        {/* A picker that cannot be set to your own tone hands back the default
            every time — the small wrongness people notice in every message. */}
        {!toneOpen && (
          <button
            type="button"
            className="w-8 h-8 shrink-0 rounded-field text-xl hover:bg-wash"
            onClick={() => setToneOpen(true)}
            title={t('emoji.skinTone')}
            aria-label={t('emoji.skinTone')}
          >
            {nativeFor(EMOJIS.wave, tone)}
          </button>
        )}
      </div>

      {!results && (
        <div role="tablist" className="flex shrink-0 justify-between px-2 border-b border-hairline">
          {sections.map(({ id }) => {
            const { icon: Icon, label } = CATEGORY[id];
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active === id}
                aria-label={t(label)}
                title={t(label)}
                onClick={() => jump(id)}
                className={`flex-1 h-8 flex items-center justify-center border-b-2 transition-colors ${
                  active === id
                    ? 'border-primary text-base-content'
                    : 'border-transparent text-subtle hover:text-strong'
                }`}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
        </div>
      )}

      <div ref={listRef} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto px-1.5 pb-2">
        {results ? (
          results.length ? (
            <div className="pt-1.5">{grid(results)}</div>
          ) : (
            <p className="py-10 text-center text-body text-subtle">{t('emoji.noMatch', { query })}</p>
          )
        ) : (
          sections.map(({ id, emojis }) => (
            // ponytail: every emoji is a real button (~1900); content-visibility
            // keeps off-screen sections out of layout and paint. Virtualise rows
            // if opening the panel ever measures slow on a low-end phone.
            <section
              key={id}
              data-cat={id}
              className="[content-visibility:auto]"
              // Roughly its real height (nine to a row), so a tab jump to a
              // section nobody has scrolled past yet lands close to it.
              style={{ containIntrinsicSize: `auto ${Math.ceil(emojis.length / 9) * 2.5 + 2}rem` }}
            >
              <h3 className="sticky top-0 z-10 bg-base-100 px-1 pt-2 pb-1 text-meta font-medium text-subtle">
                {t(CATEGORY[id].label)}
              </h3>
              {grid(emojis)}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
