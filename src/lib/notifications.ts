// Notifications, through OneSignal on Android.
//
// Two transports was one too many. Web Push (VAPID) and OneSignal both wanted
// to own the same tray entry, and the web one only ever worked in the browser
// build — which is a development convenience, not a target. The VAPID path,
// its service-worker handlers and the `push_subscriptions` writes are gone;
// what survives here are the browser-side helpers the foreground path still
// needs, plus the OneSignal wiring.
//
// **A notification never carries message content.** The server has none to
// carry — after 0023 there is no body column to read — and the copy must not
// imply otherwise. "New message from Alice" is the most that can honestly be
// said, and even the name comes from `profiles.display_name`, which the server
// does hold and which the transparency screen says so.
import { Capacitor } from '@capacitor/core';

/** Tag consulted by the In-App Message that chases an unconfirmed recovery
 *  phrase. Absent means the user has been shown twelve words and never
 *  confirmed copying them — the highest-stakes unfinished action in the app,
 *  because a lost phone then destroys the vault and no support process
 *  recovers it. */
const RECOVERY_TAG = 'recovery_confirmed';

/** Loaded lazily and only on a device. The Cordova plugin reaches for
 *  `window.cordova` at import time, which does not exist in the browser build
 *  or under vitest. */
type OneSignalModule = typeof import('onesignal-cordova-plugin').default;
let plugin: OneSignalModule | null = null;

/** How many `default` wrappers to unwrap before giving up. Two is the deepest
 *  shape observed; the bound is here so a cyclic namespace cannot hang. */
const MAX_DEFAULT_DEPTH = 4;

/**
 * The plugin instance inside whatever the dynamic import hands back.
 *
 * `onesignal-cordova-plugin` declares `"type": "module"` but ships a CommonJS
 * `main`, so the bundler wraps it twice: the namespace's `default` is the CJS
 * exports object, and the instance is one level below that at
 * `.default.default`. Reading `.default` gave a bag of exported classes with no
 * `initialize` on it, every call in this module threw into its own catch, and
 * the whole notification stack failed without a word — the Settings toggle
 * refused to turn on, and OneSignal's native side logged "no appId provided" at
 * every launch because `initialize` had never reached it.
 *
 * Unwrapping by feature rather than by a fixed number of hops keeps this
 * working whichever shape a future bundler or plugin release produces.
 */
export function resolveOneSignal(mod: unknown): OneSignalModule | null {
  let candidate = mod;
  for (let depth = 0; depth <= MAX_DEFAULT_DEPTH; depth++) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.initialize === 'function') return candidate as OneSignalModule;
    if (record.default === candidate) return null;
    candidate = record.default;
  }
  return null;
}

async function oneSignal(): Promise<OneSignalModule | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (plugin) return plugin;
  try {
    plugin = resolveOneSignal(await import('onesignal-cordova-plugin'));
    return plugin;
  } catch {
    return null;
  }
}

let initialised = false;

/**
 * Starts OneSignal and binds this device to the Supabase account.
 *
 * The external user id is the Supabase user id, so a campaign targets an
 * account rather than a device — which is what makes the recovery-phrase
 * message land on the right person when they have two phones, and what stops
 * it following the account off a phone that has been handed on.
 */
export async function initNotifications(userId: string): Promise<void> {
  const os = await oneSignal();
  if (!os) return;

  const appId = import.meta.env.VITE_ONESIGNAL_APP_ID;
  if (!appId) return;

  try {
    if (!initialised) {
      os.initialize(appId);
      initialised = true;
    }
    os.login(userId);
  } catch {
    // A notification transport that cannot start must not stop the messenger.
  }
}

/** Unbind this device from the account, so notifications for it stop arriving
 *  here. Called on sign-out; see App's `signOut`. */
export async function clearExternalUserId(): Promise<void> {
  const os = await oneSignal();
  os?.logout();
}

/** Asks, at the moment the user turns notifications on — never at launch. */
export async function requestPushPermission(): Promise<boolean> {
  const os = await oneSignal();
  if (!os) return false;
  try {
    return await os.Notifications.requestPermission(true);
  } catch {
    return false;
  }
}

/**
 * Whether Android would still show the permission dialog if asked.
 *
 * Android 13 stops offering the dialog once it has been dismissed, and from
 * then on `requestPermission` returns false without anything appearing on
 * screen. That is the difference between "tap this and you will be asked" and
 * "the only way back is system settings", and the app has to say which one it
 * is or the toggle reads as broken.
 */
export async function canRequestPushPermission(): Promise<boolean> {
  const os = await oneSignal();
  if (!os) return false;
  try {
    return await os.Notifications.canRequestPermission();
  } catch {
    return false;
  }
}

export interface PushState {
  granted: boolean;
  canRequest: boolean;
}

/** True when the only remaining route is the system settings app. */
export function pushBlockedByOs({ granted, canRequest }: PushState): boolean {
  return !granted && !canRequest;
}

export interface PushOfferState extends PushState {
  native: boolean;
  /** Whether this account has already been shown the one-time offer. */
  alreadyAsked: boolean;
}

/**
 * Whether to show the one-time offer that gets a new install asked at all.
 *
 * Nothing in the app used to ask. The permission was reachable only from a
 * toggle buried in Settings, so an install that never opened that screen never
 * saw the dialog and never received a notification, with nothing anywhere
 * saying why.
 *
 * It is still not asked at launch. It waits until the account exists and the
 * recovery phrase is dealt with, which is the first moment "we can tell you
 * when a message arrives" means anything to the person reading it. And it is
 * asked once: a card that comes back every launch is what teaches people to
 * deny by reflex.
 */
export function shouldOfferPush(state: PushOfferState): boolean {
  if (!state.native || state.alreadyAsked) return false;
  return !state.granted && state.canRequest;
}

const OFFER_KEY = 'nearside.push.offered';

/** Per account, because two people sharing a phone each get asked once. */
export function pushOfferSeen(userId: string): boolean {
  try {
    return localStorage.getItem(`${OFFER_KEY}.${userId}`) === '1';
  } catch {
    // No storage means we cannot remember the answer, and asking on every
    // launch is worse than never asking again.
    return true;
  }
}

export function markPushOfferSeen(userId: string): void {
  try {
    localStorage.setItem(`${OFFER_KEY}.${userId}`, '1');
  } catch {
    /* ignore storage failures */
  }
}

export async function hasPushPermission(): Promise<boolean> {
  const os = await oneSignal();
  if (!os) return false;
  try {
    return await os.Notifications.getPermissionAsync();
  } catch {
    return false;
  }
}

export async function setPushEnabled(enabled: boolean): Promise<void> {
  const os = await oneSignal();
  if (!os) return;
  if (enabled) os.User.pushSubscription.optIn();
  else os.User.pushSubscription.optOut();
}

/**
 * Records whether this account has confirmed its recovery phrase.
 *
 * Written as a tag rather than inferred server-side because the server has no
 * way to know: confirmation happens against a seed held in Android's Keystore,
 * and nothing about it is ever uploaded. The In-App Message targets the
 * absence of `true`.
 */
export async function setRecoveryConfirmed(confirmed: boolean): Promise<void> {
  const os = await oneSignal();
  try {
    os?.User.addTag(RECOVERY_TAG, confirmed ? 'true' : 'false');
  } catch {
    // Tagging is best effort; the gate in the app is the real protection.
  }
}

/** Which conversation a tapped notification meant, if the payload named one. */
export async function onNotificationOpened(
  handler: (senderId: string) => void
): Promise<void> {
  const os = await oneSignal();
  if (!os) return;
  try {
    os.Notifications.addEventListener('click', (event) => {
      const data = event.notification.additionalData as { senderId?: string } | undefined;
      if (data?.senderId) handler(data.senderId);
    });
  } catch {
    // No listener means a tap just opens the app, which is the old behaviour.
  }
}

// ---- Browser-side helpers, still used by the foreground path ----------------
//
// These are about the `Notification` API in the WebView, not about a transport.
// `useMessageNotifications` raises a banner for a message that arrives while
// the app is open and focused elsewhere, and that path is unchanged by the move
// to OneSignal.

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * The browser's own notification permission.
 *
 * An Android WebView has no `window.Notification` at all, so this answers
 * "denied" on the platform the app actually ships to, and the foreground
 * banner path it gates never runs there. That is the right outcome rather than
 * a gap: on Android the tray entry comes from OneSignal, which shows it whether
 * the app is open or not. This is here for the browser build.
 */
export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

/**
 * Dismiss any notifications already shown for a conversation.
 *
 * Opening a chat is the user reading it, so leaving three stacked banners in
 * the tray afterwards is noise — and worse, it keeps the app icon lit for
 * messages that are visibly on screen. Matched by the same `dm:<senderId>` tag
 * the foreground path uses.
 */
export async function closeNotificationsFor(tag: string): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const shown = await registration.getNotifications({ tag });
    for (const notification of shown) notification.close();
  } catch {
    // getNotifications is unimplemented on some engines; nothing to clean up.
  }
}
