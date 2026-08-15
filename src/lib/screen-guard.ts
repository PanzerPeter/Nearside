// FLAG_SECURE, through the local `ScreenGuard` plugin in
// android/app/src/main/java/app/nearside/ScreenGuard.java.
//
// A no-op in a browser, like every other native surface here: there is no web
// equivalent, and pretending otherwise would let a browser session be mistaken
// for the protection the Android build actually has.
import { registerPlugin } from '@capacitor/core';
import { isMobileNative } from './platform';

interface ScreenGuardPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const ScreenGuard = registerPlugin<ScreenGuardPlugin>('ScreenGuard');

/**
 * Who currently wants the flag held.
 *
 * The flag is one global boolean and there is more than one reason to want it:
 * the recovery-phrase screen holds it for two stages, and the app lock holds it
 * for the whole session. Without this set, whichever of them released last won
 * — unmounting the phrase screen cleared the lock's hold, and the recents
 * thumbnail was exposed for the rest of the session with the lock still on.
 */
const holders = new Set<string>();

/**
 * Block screenshots, screen recording and the recents thumbnail, or stop.
 *
 * `reason` names the caller so two of them can hold it independently. Callers
 * that release must pass the same reason they took it with.
 */
export async function setScreenGuard(on: boolean, reason = 'default'): Promise<void> {
  const wanted = holders.size > 0;
  if (on) holders.add(reason);
  else holders.delete(reason);
  const nowWanted = holders.size > 0;
  if (!isMobileNative() || nowWanted === wanted) return;
  try {
    await (nowWanted ? ScreenGuard.enable() : ScreenGuard.disable());
  } catch {
    // An older install without the plugin must not strand the caller. The
    // screen it protects is still worth showing; it is just not protected.
  }
}
