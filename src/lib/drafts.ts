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

/**
 * Listeners for the chat list, which shows a `Draft:` mark on a conversation
 * holding unsent text.
 *
 * A plain module Map has nothing to subscribe to, so the list had no way of
 * knowing a draft existed and half-typed messages were invisible the moment you
 * left the conversation — which for an in-memory store is exactly when they are
 * easiest to forget about. Same shape as `subscribeChatFlags`.
 */
const listeners = new Set<() => void>();

/** Bumped on every change worth repainting for. `useSyncExternalStore` needs a
 *  snapshot that is `Object.is`-stable between notifications, and a counter is
 *  the cheapest thing that is. */
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export function draftsVersion(): number {
  return version;
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a conversation is holding unsent text, without handing it out. The
 *  list needs to know that there is a draft, never what it says. */
export function hasDraft(kind: 'peer' | 'room', id: string): boolean {
  return drafts.has(draftKey(kind, id));
}

/** The draft itself, for the one caller that shows a preview of it. */
export function peekDraft(kind: 'peer' | 'room', id: string): string {
  return drafts.get(draftKey(kind, id)) ?? '';
}

/** Namespaced so a room id can never collide with a peer id. */
export function draftKey(kind: 'peer' | 'room', id: string): string {
  return `${kind}:${id}`;
}

export function getDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Store `text`, or forget the conversation when it holds nothing typed. */
export function putDraft(key: string, text: string): void {
  const had = drafts.has(key);
  if (!text.trim()) drafts.delete(key);
  else drafts.set(key, text);
  // Only when the row's mark would actually change. Notifying on every
  // keystroke would re-render the whole chat list per character typed.
  if (had !== drafts.has(key)) notify();
}

export function clearDraft(key: string): void {
  if (drafts.delete(key)) notify();
}

/** Sign-out and the account switcher: drafts belong to the account that typed
 *  them. See `releaseAccount` in `App.tsx`. */
export function forgetAllDrafts(): void {
  drafts.clear();
  notify();
}
