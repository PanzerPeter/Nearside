// The line somebody writes about themselves.
//
// Pure, like `nicknames.ts`'s normalizer and for the same reason: the rules
// have to be enforced in two places that cannot see each other — here, before
// the write leaves the device, and by the `bio_length` CHECK in 0040, for the
// callers that are not this client. A rule the database holds and the client
// does not surfaces as an unexplained 23514 at the moment somebody presses
// save.
//
// Unlike a display name or a nickname, a bio is a block: it renders in a box of
// its own on the profile card and nowhere inline, so newlines survive.

/** Matches the `bio_length` CHECK in 0040. */
export const MAX_BIO_LENGTH = 200;

/** Most consecutive newlines a bio may keep. Two is a paragraph break; eleven
 *  is somebody pushing their one line to the bottom of everyone else's card. */
const MAX_CONSECUTIVE_NEWLINES = 2;

/**
 * A bio as it may be stored, or null if `raw` holds nothing worth storing.
 *
 * Null rather than an empty string, because that is the distinction the column
 * makes: NULL is "has never written one", and the CHECK refuses the blank
 * string that would otherwise be a second way of saying it.
 *
 * Over-long input is truncated rather than refused. It only arrives by paste —
 * the field itself is capped at the same length — and silently dropping what
 * somebody pasted is worse than keeping the part that fits.
 */
export function normalizeBio(raw: string): string | null {
  const unified = raw.replace(/\r\n?/g, '\n');
  // Every control character except the newline, which is the one this field
  // exists to keep. A stray tab or form feed renders as a hole in the block.
  // eslint-disable-next-line no-control-regex
  const stripped = unified.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  const collapsed = stripped.replace(
    new RegExp(`\\n{${MAX_CONSECUTIVE_NEWLINES + 1},}`, 'g'),
    '\n'.repeat(MAX_CONSECUTIVE_NEWLINES),
  );
  // Trimmed before the cut as well as after: leading whitespace would
  // otherwise eat characters out of the 200 that are allowed.
  const trimmed = collapsed.trim().slice(0, MAX_BIO_LENGTH).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** What the counter under the field shows. Counts the value that would
 *  actually be stored, so it cannot read 200/200 for text that normalizes to
 *  fewer — the number has to be the one the save obeys. */
export function bioLength(raw: string): number {
  return normalizeBio(raw)?.length ?? 0;
}
