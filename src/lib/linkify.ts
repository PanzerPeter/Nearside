// Whitelist, not a blacklist: matching only these two shapes is what keeps
// `javascript:` and `data:` payloads from ever reaching an anchor's `href` —
// widening this pattern to "anything with a colon" would reopen that hole.
const URL_TOKEN = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/gi;

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string };

/**
 * A message often ends a URL with sentence punctuation the author didn't mean
 * as part of the link ("see https://x.com."). Parens are the one case that's
 * ambiguous on their own — a wiki-style URL can legitimately end in `)` — so
 * only strip a trailing `)` that isn't balanced by an opening one earlier in
 * the token.
 */
function trimTrailing(token: string): string {
  let value = token;
  while (value.length > 0) {
    const last = value[value.length - 1];
    if ('.,;:!?'.includes(last)) {
      value = value.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = (value.match(/\(/g) ?? []).length;
      const closes = (value.match(/\)/g) ?? []).length;
      if (closes > opens) {
        value = value.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return value;
}

// Trimming punctuation can eat the part that made the token a URL at all:
// "www.!" survives the token match but trims down to a bare "www", which is a
// word, not a host. Anything that no longer carries a host after the prefix
// goes back to being plain text.
const USABLE = /^(https?:\/\/.+|www\.[^\s.])/i;

export function linkify(text: string): Segment[] {
  if (!text) return [];

  const segments: Segment[] = [];
  let cursor = 0;
  URL_TOKEN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = URL_TOKEN.exec(text))) {
    const trimmed = trimTrailing(match[0]);
    const start = match.index;

    if (start > cursor) segments.push({ type: 'text', value: text.slice(cursor, start) });

    if (!USABLE.test(trimmed)) {
      segments.push({ type: 'text', value: match[0] });
      cursor = start + match[0].length;
      URL_TOKEN.lastIndex = cursor;
      continue;
    }

    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    segments.push({ type: 'link', value: trimmed, href });

    cursor = start + trimmed.length;
    // The regex is stateful across calls (global flag); resume the scan
    // where the trimmed value ends, not where the greedy raw match did, or
    // the punctuation just stripped off would be silently dropped from
    // the text instead of surfacing in the next text segment.
    URL_TOKEN.lastIndex = cursor;
  }

  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });

  return segments;
}
