// The names a notification may show, handed to the Android extension.
//
// Since 0061 the server knows nobody's name, so a push arrives as "someone
// sent a photo". The chat list has already opened every name it shows, and
// passes them down here so `NameStore.java` can put them back into the banner
// on this phone. A no-op anywhere but the Android build; the iOS banner stays
// nameless until it has a notification service extension of its own.

import { registerPlugin } from '@capacitor/core';
import { hasProprietaryPlugins } from './platform';

interface NameStorePlugin {
  setNames(options: { scope: 'peers' | 'rooms'; names: Record<string, string> }): Promise<void>;
  clear(): Promise<void>;
}

const NameStore = registerPlugin<NameStorePlugin>('NameStore');

const lastWritten: Record<'peers' | 'rooms', string | null> = { peers: null, rooms: null };

// Only where there is push at all. iOS has no NameStore yet and answers with a
// rejection, which is caught: the banner there just stays nameless.
const supported = hasProprietaryPlugins;

export async function publishNotificationNames(
  scope: 'peers' | 'rooms',
  names: Record<string, string>
): Promise<void> {
  const key = JSON.stringify(names);
  if (key === lastWritten[scope]) return;
  lastWritten[scope] = key;
  if (!supported()) return;
  try {
    await NameStore.setNames({ scope, names });
  } catch {
    // An install whose native half predates the plugin shows "someone".
  }
}

/** Part of the account teardown: plaintext names do not outlive the account. */
export function forgetNotificationNames(): void {
  lastWritten.peers = null;
  lastWritten.rooms = null;
  if (supported()) void NameStore.clear().catch(() => {});
}
