// The muted set, mirrored to where a notification can read it.
//
// A push arrives when the WebView is not running — that is the case the whole
// notification path exists for — so a mute list held in JavaScript, in
// IndexedDB, or in the SQLite mirror is unreadable at the only moment it
// matters. The `MuteStore` plugin puts it in SharedPreferences, which the
// OneSignal notification extension can read with no process of ours alive.
//
// A no-op off Android, like every other native surface here. The desktop and
// browser builds will still ring for a muted chat, and the settings page says
// so rather than letting the toggle imply otherwise.
import { registerPlugin } from '@capacitor/core';
import { isMobileNative } from './platform';
import { mutedIds, type ChatFlags } from './chat-flags';

interface MuteStorePlugin {
  setMuted(options: { userId: string; ids: string[] }): Promise<void>;
}

const MuteStore = registerPlugin<MuteStorePlugin>('MuteStore');

/** The muted set as this session last computed it, for the code paths that
 *  need the answer synchronously and hold no flags of their own — the in-app
 *  banner and the unread badge. */
let mutedNow: ReadonlySet<string> = new Set();

/** Whether this conversation is muted, as of the last list refresh. */
export function isMutedNow(id: string): boolean {
  return mutedNow.has(id);
}

/** The set as last written, so an unchanged list does not rewrite native
 *  storage on every list refresh — and the write still happens after an account
 *  switch, because the key includes the user id. */
let lastWritten: string | null = null;

/** Hand the current muted set to the notification extension. */
export async function syncMutedIds(
  userId: string,
  flags: ReadonlyMap<string, ChatFlags>
): Promise<void> {
  const ids = mutedIds(flags);
  mutedNow = new Set(ids);
  const key = `${userId}:${ids.join(',')}`;
  if (key === lastWritten) return;
  lastWritten = key;
  if (!isMobileNative()) return;
  try {
    await MuteStore.setMuted({ userId, ids });
  } catch {
    // An install whose native half predates this plugin keeps ringing for muted
    // chats. Failing the mute toggle over it would be worse: the in-app
    // suppression still works, and the list still shows the chat as muted.
  }
}

/** Sign-out and the account switcher: the next account must not inherit these
 *  silences, and the memo above must not suppress its first write. */
export function forgetMutedIds(): void {
  lastWritten = null;
  mutedNow = new Set();
}
