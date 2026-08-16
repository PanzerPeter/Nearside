// Mentions, entirely on this device.
//
// `@name` is inside the sealed body, so the server cannot know a mention
// happened and a mention cannot get a push of its own. That is a limit the UI
// states (Settings → Notifications) rather than one to work around: telling
// the server who was named would mean telling it what the message says.
//
// Matched against the room's actual display names rather than against a
// pattern. `profiles.display_name` is not unique and is not word-shaped — any
// single-line string up to 32 characters — so there is no regex that could
// know where a name ends. Only the member list knows.

export interface Mention {
  /** The name as the room holds it, not as it was typed. */
  handle: string;
  /** Index of the `@`, and one past the last character of the name. */
  start: number;
  end: number;
}

/** A character that may not sit directly before the `@` — this is what keeps
 *  `anna@example.com` from reading as a mention of Anna. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

export function findMentions(text: string, handles: string[]): Mention[] {
  if (!text.includes('@')) return [];

  // Longest first: with "Anna" and "Anna Lee" both in the room, "@Anna Lee"
  // is a mention of the second, and matching the first would highlight half a
  // name and leave a stray surname beside it.
  const candidates = handles
    .filter((h) => h.trim().length > 0)
    .slice()
    .sort((a, b) => b.length - a.length);

  const lower = text.toLowerCase();
  const found: Mention[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || isWordChar(text[i - 1])) continue;

    for (const handle of candidates) {
      const end = i + 1 + handle.length;
      if (lower.slice(i + 1, end) !== handle.toLowerCase()) continue;
      // The name has to end where it ends. Without this, "@ann" matches
      // inside "@annabel" and the highlight stops mid-word.
      if (isWordChar(text[end])) continue;
      found.push({ handle, start: i, end });
      i = end - 1;
      break;
    }
  }

  return found;
}

/** Whether this message names me. `myHandle` empty means no name to match —
 *  a profile that has not finished loading must not light up every message. */
export function mentionsMe(text: string, myHandle: string): boolean {
  if (!myHandle.trim()) return false;
  return findMentions(text, [myHandle]).length > 0;
}
