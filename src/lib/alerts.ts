// How loudly each conversation arrives, mirrored to where a notification can
// read it.
//
// The same problem `lib/mute.ts` solves, and the same answer. A push is
// delivered when the WebView is not running — that is the case the whole
// notification path exists for — so a preference held in JavaScript, in
// IndexedDB or in the SQLite mirror is unreadable at the only moment it
// matters. `AlertStore` puts it in SharedPreferences, which the notification
// extension reads with no process of ours alive.
//
// Two stores rather than one, beside the mute list, because they answer
// different questions: mute decides whether anything is shown at all, and this
// decides how it sounds when it is. Folding them together would mean unmuting
// had to guess which loudness to return to.
//
// A no-op off Android, like every other native surface here. The desktop and
// browser builds have one loudness and the settings copy says so.

import { registerPlugin } from '@capacitor/core';
import { isMobileNative } from './platform';
import { alertLevels, type AlertLevel, type ChatFlags } from './chat-flags';

interface AlertStorePlugin {
  setLevels(options: { userId: string; levels: Record<string, AlertLevel> }): Promise<void>;
  clear(): Promise<void>;
}

const AlertStore = registerPlugin<AlertStorePlugin>('AlertStore');

/** What was last written, so an unchanged map does not rewrite native storage
 *  on every list refresh — and the write still happens after an account
 *  switch, because the key includes the user id. */
let lastWritten: string | null = null;

/** A stable string for a map whose key order is not. */
function fingerprint(userId: string, levels: Record<string, AlertLevel>): string {
  return (
    userId +
    ':' +
    Object.entries(levels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, level]) => `${id}=${level}`)
      .join(',')
  );
}

/** Hand the current per-conversation loudness to the notification extension. */
export async function syncAlertLevels(
  userId: string,
  flags: ReadonlyMap<string, ChatFlags>
): Promise<void> {
  const levels = alertLevels(flags);
  const key = fingerprint(userId, levels);
  if (key === lastWritten) return;
  lastWritten = key;
  if (!isMobileNative()) return;
  try {
    await AlertStore.setLevels({ userId, levels });
  } catch {
    // An install whose native half predates this plugin gets the ordinary
    // loudness for everything. Failing the setting over it would be worse: the
    // choice is still recorded and still shown, and it starts being honoured
    // when the native half catches up.
  }
}

/** Sign-out and the account switcher: the next account must not inherit these
 *  choices, and the memo above must not suppress its first write. */
export function forgetAlertLevels(): void {
  lastWritten = null;
  if (!isMobileNative()) return;
  void AlertStore.clear().catch(() => {});
}
