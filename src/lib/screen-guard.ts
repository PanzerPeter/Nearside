// FLAG_SECURE, through the local `ScreenGuard` plugin in
// android/app/src/main/java/app/nearside/ScreenGuard.java.
//
// A no-op in a browser, like every other native surface here: there is no web
// equivalent, and pretending otherwise would let a browser session be mistaken
// for the protection the Android build actually has.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface ScreenGuardPlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

const ScreenGuard = registerPlugin<ScreenGuardPlugin>('ScreenGuard');

/** Block screenshots, screen recording and the recents thumbnail, or stop. */
export async function setScreenGuard(on: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await (on ? ScreenGuard.enable() : ScreenGuard.disable());
  } catch {
    // An older install without the plugin must not strand the caller. The
    // screen it protects is still worth showing; it is just not protected.
  }
}
