// Which shell the app is running in, and what that shell can actually do.
//
// This module exists because `Capacitor.isNativePlatform()` answers a question
// the app does not have. It returns true on Electron, so a desktop build would
// take every mobile branch in the codebase — and the desktop shell has none of
// what those branches assume:
//
//   - The seed. `capacitor-secure-storage-plugin` has a web implementation, and
//     Capacitor falls back to it on Electron. So the branch does not throw; it
//     quietly writes the identity key to localStorage while
//     `isSecureStorageAvailable()` reports hardware-backed storage. A false
//     security claim is worse than a missing feature.
//   - The mirror. `@capacitor-community/sqlite` needs a web component that is
//     never mounted here, so a "native" store would fail every read.
//   - OneSignal, RevenueCat and the local ScreenGuard plugin have no web
//     implementation at all and throw on call.
//
// So the app asks `isMobileNative()` instead, which means what the call sites
// have always meant: Android or iOS. On those two it is exactly what
// `isNativePlatform()` returned, so nothing about the shipping builds changes.
// Electron takes the browser path, which the app already supports.
//
// `Capacitor.getPlatform()` is called here, in `lib/scan.ts` (a permission flow
// that exists only on Android) and in `lib/purchases.ts` (App Store versus Play
// pricing). Everywhere else, ask this module.
import { Capacitor } from '@capacitor/core';

/**
 * Android or iOS — a shell with the native plugins the app was built against.
 *
 * The replacement for `Capacitor.isNativePlatform()` at every call site. Not
 * "is this not a browser": Electron is not a browser and still cannot do any of
 * this.
 */
export function isMobileNative(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios';
}

/** The Electron desktop shell. Distinct from the browser build in the few
 *  places where desktop packaging matters, and identical to it everywhere
 *  plugins are concerned. */
export function isDesktop(): boolean {
  return Capacitor.getPlatform() === 'electron';
}
