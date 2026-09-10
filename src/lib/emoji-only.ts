/** Largest run that still reads as a gesture rather than as a body of text.
 *  Past three, a jumbo glyph stops being punctuation on the conversation and
 *  starts being a wall. */
const JUMBO_MAX = 3;

/** Two regional indicators are a flag: neither half is pictographic on its own,
 *  so a flag would otherwise fail every test below. */
const FLAG = /^\p{Regional_Indicator}\p{Regional_Indicator}$/u;
/** A digit, `#` or `*` wearing a keycap. The base character is ASCII, so this
 *  is the one emoji that has to be recognised by its suffix. */
const KEYCAP = /^[0-9#*]️?⃣$/u;
/** Anything from the emoji planes proper — every face, hand, animal, object. */
const PICTOGRAPHIC_PLANE = /[\u{1F000}-\u{1FAFF}]/u;

/** Emoji presentation asked for explicitly, which is what separates `❤️` from
 *  the `❤` somebody typed, and `™️` from the trademark sign in a sentence.
 *  Without this the older text-default symbols — © ® ™ ‼ ↔ — would all render
 *  three times life size in the middle of an ordinary message. */
const VARIATION_SELECTOR_16 = '️';

function isEmoji(grapheme: string): boolean {
  if (FLAG.test(grapheme)) return true;
  if (KEYCAP.test(grapheme)) return true;
  if (grapheme.includes(VARIATION_SELECTOR_16)) return true;
  return PICTOGRAPHIC_PLANE.test(grapheme);
}

/**
 * How many emoji to draw large, or 0 when this message is ordinary text.
 *
 * A body of nothing but one to three emoji is a reaction someone sent as a
 * message, and every other messenger draws it at a size you can read across a
 * room. Anything else — an emoji with a word beside it, a fourth emoji — is
 * text and stays text.
 *
 * Counted in grapheme clusters, not code points: a family, a thumb with a skin
 * tone and a flag are each one thing on screen and one thing here. Whitespace
 * between them doesn't count and doesn't disqualify.
 */
export function jumboEmojiCount(text: string): number {
  const body = text.trim();
  if (!body) return 0;
  // No segmenter, no reliable grapheme boundaries — better to render the
  // message as plain text than to slice a ZWJ sequence into pieces.
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return 0;

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const { segment } of segmenter.segment(body)) {
    if (!segment.trim()) continue;
    if (!isEmoji(segment)) return 0;
    count += 1;
    if (count > JUMBO_MAX) return 0;
  }
  return count;
}
