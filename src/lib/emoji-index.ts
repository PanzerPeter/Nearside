// The emoji set, searched, skinned and remembered — everything the picker
// does that is not drawing.
//
// This used to be emoji-mart, a custom element in a shadow DOM that the app
// could only reach through a handful of RGB-triple custom properties mirrored
// by hand from the theme. Its data package is kept: it is the Unicode list with
// names and keywords, and that is a table, not a dependency worth replacing.
//
// Pure apart from the storage at the bottom, so the parts worth proving —
// search order, skin fallback, the version cut — run in the node suite.

import data from '@emoji-mart/data';

export interface EmojiSkin {
  native: string;
}

export interface EmojiEntry {
  id: string;
  name: string;
  keywords: string[];
  emoticons?: string[];
  skins: EmojiSkin[];
  version: number;
}

export interface EmojiCategory {
  id: string;
  emojis: EmojiEntry[];
}

interface EmojiData {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, EmojiEntry>;
}

const DATA = data as unknown as EmojiData;

export const EMOJIS: Record<string, EmojiEntry> = DATA.emojis;

/**
 * The categories, with every emoji newer than this device can draw left out.
 *
 * An emoji the system font does not have renders as a box, or a ZWJ sequence
 * falls apart into the people it was built from. Offering one is offering a
 * message the sender cannot even see before sending it.
 */
export function categoriesFor(maxVersion: number, flags = true): EmojiCategory[] {
  return DATA.categories
    .filter((c) => flags || c.id !== 'flags')
    .map((c) => ({
      id: c.id,
      emojis: c.emojis.map((id) => DATA.emojis[id]).filter((e) => e && e.version <= maxVersion),
    }));
}

/** 1 is the yellow default; 2–6 are the Fitzpatrick tones, in the data's order. */
export type SkinTone = 1 | 2 | 3 | 4 | 5 | 6;

/** The character to insert. An emoji with no toned variants is the same in every tone. */
export function nativeFor(emoji: EmojiEntry, tone: SkinTone): string {
  return (emoji.skins[tone - 1] ?? emoji.skins[0]).native;
}

// One comma-led string per emoji, so a query word matches the *start* of any
// word in it: ",smi" finds "smile" and "smiling" but not "tiramisu". The name is
// split into words; id and keywords are whole tokens already.
let haystacks: Map<EmojiEntry, string> | null = null;
function haystack(e: EmojiEntry): string {
  haystacks ??= new Map(
    Object.values(DATA.emojis).map((x) => [
      x,
      ',' +
        [x.id, ...x.name.split(/[-_\s]+/), ...x.keywords, ...(x.emoticons ?? [])]
          .map((s) => s.toLowerCase())
          .filter((s) => s.trim())
          .join(','),
    ])
  );
  return haystacks.get(e) ?? '';
}

/**
 * Every emoji matching all of the query's words, best first.
 *
 * A word scores by how early it lands in the emoji's string — its id and name
 * come first, so "heart" puts ❤️ ahead of everything that merely mentions love
 * — and an exact id costs nothing. Ties go alphabetical by id, so the order is
 * stable between keystrokes.
 */
export function searchEmoji(
  query: string,
  pool: readonly EmojiEntry[],
  limit = 90
): EmojiEntry[] {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean)
    ),
  ];
  if (!words.length) return [];
  const scored: { e: EmojiEntry; score: number }[] = [];
  for (const e of pool) {
    const hay = haystack(e);
    let score = 0;
    let all = true;
    for (const w of words) {
      const at = hay.indexOf(',' + w);
      if (at === -1) {
        all = false;
        break;
      }
      score += e.id === w ? 0 : at + 1;
    }
    if (all) scored.push({ e, score });
  }
  scored.sort((a, b) => a.score - b.score || a.e.id.localeCompare(b.e.id));
  return scored.slice(0, limit).map((s) => s.e);
}

// ---------------------------------------------------------------- storage
//
// Device-wide, as emoji-mart's was: unlike the sticker shelf these are ids into
// a public table, not into one account's rows. Never uploaded.

const RECENT_KEY = 'nearside.emoji.recent';
const SKIN_KEY = 'nearside.emoji.skin';
export const EMOJI_RECENT_LIMIT = 24;

/** Shown before anything has been picked, so the row is not a blank strip. */
const STARTER = ['+1', 'joy', 'heart_eyes', 'heart', 'sob', 'pray', 'fire', 'sweat_smile', 'thinking_face'];

/**
 * emoji-mart kept `{ id: useCount }` under its own key. Reading it once, by
 * count, means an update does not hand everybody an empty recents row.
 */
function legacyRecents(): string[] {
  const raw = localStorage.getItem('emoji-mart.frequently');
  if (!raw) return [];
  const counts = JSON.parse(raw) as Record<string, number>;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
}

/** Recent ids, newest first, limited to ones still in the set. */
export function recentEmojiIds(): string[] {
  let ids: unknown;
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    ids = raw ? JSON.parse(raw) : legacyRecents();
  } catch {
    ids = [];
  }
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && EMOJIS[id]) : [];
  return (list.length ? list : STARTER).slice(0, EMOJI_RECENT_LIMIT);
}

export function recordEmojiUse(id: string): void {
  const next = [id, ...recentEmojiIds().filter((x) => x !== id)].slice(0, EMOJI_RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage off or full; the row is a convenience.
  }
}

export function storedSkinTone(): SkinTone {
  try {
    // emoji-mart stored a JSON number under its own key; honour it until the
    // user picks again here.
    const n = Number(localStorage.getItem(SKIN_KEY) ?? localStorage.getItem('emoji-mart.skin'));
    return n >= 1 && n <= 6 ? (n as SkinTone) : 1;
  } catch {
    return 1;
  }
}

export function storeSkinTone(tone: SkinTone): void {
  try {
    localStorage.setItem(SKIN_KEY, String(tone));
  } catch {
    // As above.
  }
}
