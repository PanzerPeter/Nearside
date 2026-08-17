/**
 * Unsent message text, per conversation, for as long as the app is running.
 *
 * The composer's text used to live in `ChatRoom`'s own state, which is wrong in
 * both directions. The pane is not remounted when the selected friend changes —
 * there is no `key` on it — so on a split-screen layout a half-typed message to
 * one person stayed in the box under the next person's name, one Enter from
 * being sent to them. On a phone the pane *is* unmounted by the back gesture,
 * so the same state lost the draft entirely.
 *
 * In memory on purpose. A draft is a message nobody has agreed to send yet, and
 * writing it to localStorage or the SQLite mirror would leave it in plaintext
 * on disk after the app is closed — outliving the intent that produced it. The
 * cost is that drafts do not survive the app being killed, which is the honest
 * trade for a messenger whose whole claim is that the plaintext is only where
 * you put it.
 */

const drafts = new Map<string, string>();

/** Namespaced so a room id can never collide with a peer id. */
export function draftKey(kind: 'peer' | 'room', id: string): string {
  return `${kind}:${id}`;
}

export function getDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Store `text`, or forget the conversation when it holds nothing typed. */
export function putDraft(key: string, text: string): void {
  if (!text.trim()) drafts.delete(key);
  else drafts.set(key, text);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** Sign-out and the account switcher: drafts belong to the account that typed
 *  them. See `releaseAccount` in `App.tsx`. */
export function forgetAllDrafts(): void {
  drafts.clear();
}
