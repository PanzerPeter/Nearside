// Which keystroke means what, decided in one place.
//
// The app had exactly one shortcut before this — Escape — which on a desktop
// window makes it feel like a phone app someone stretched. Everything here is
// deliberately a desktop affordance: none of it is reachable on a touchscreen
// and none of it is the only way to do anything.
//
// Pure, and the whole point of that is the guard below: a shortcut that fires
// while somebody is typing a message is worse than no shortcut, and "was the
// user typing" is the part that is easy to get subtly wrong and impossible to
// check by looking at a screen.

/** What a keystroke asked for, or null when it asked for nothing. */
export type Shortcut =
  /** Find a conversation: focus the search across all chats. */
  | 'search-all'
  /** Search inside the conversation that is open. */
  | 'search-chat'
  /** Move the selection up or down the chat list. */
  | 'previous-chat'
  | 'next-chat'
  /** Put the open conversation on the shelf, or take it off. */
  | 'archive-chat';

/**
 * The fields a shortcut must never fire inside.
 *
 * A composer is a `<textarea>`, the search boxes are `<input>`, and the
 * nickname dialog is another. `isContentEditable` covers anything a future
 * rich editor brings with it. Without this, Ctrl+E in the middle of writing a
 * message archives the conversation being written to.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The platform's own modifier: ⌘ on a Mac, Ctrl everywhere else. Read from the
 *  event rather than from the user agent, so a Mac keyboard on another OS and
 *  an external keyboard on a Mac both behave the way their user expects. */
function primary(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

/**
 * What this keystroke means, or null.
 *
 * The two search shortcuts are allowed to fire while a field has focus, and
 * only those two: Ctrl+F typed into the composer means "search this
 * conversation" in every messenger anybody has used, and refusing it there
 * would be the surprise. Everything that *changes* something — moving to
 * another chat, archiving one — is refused while typing.
 */
export function shortcutFor(e: KeyboardEvent): Shortcut | null {
  // A browser shortcut being composed (`AltGr`, a dead key) or an IME in the
  // middle of a word must not be read as a command.
  if (e.isComposing || e.repeat) return null;

  if (primary(e) && !e.shiftKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key === 'k') return 'search-all';
    if (key === 'f') return 'search-chat';
    if (key === 'e') return isTyping(e.target) ? null : 'archive-chat';
  }

  // Alt with an arrow, deliberately not Ctrl: Ctrl+↑/↓ is "top/bottom of the
  // document" on Windows and Linux, and the thread is a document.
  if (e.altKey && !primary(e) && !e.shiftKey && !isTyping(e.target)) {
    if (e.key === 'ArrowUp') return 'previous-chat';
    if (e.key === 'ArrowDown') return 'next-chat';
  }

  return null;
}

/**
 * The conversation `delta` steps from `current` in a list of ids.
 *
 * Null when there is nowhere to go, so the caller does nothing rather than
 * wrapping around — a list that loops means holding the key gets you back to
 * where you started with no way to tell.
 *
 * With nothing selected, the first step in either direction lands on an end of
 * the list: down on the newest conversation, up on the oldest.
 */
export function stepChat(
  ids: readonly string[],
  current: string | null,
  delta: number
): string | null {
  if (ids.length === 0) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at === -1) return delta > 0 ? ids[0] : ids[ids.length - 1];
  const next = at + delta;
  if (next < 0 || next >= ids.length) return null;
  return ids[next];
}
