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
export const RECOVERY_TAG = 'recovery_confirmed';

/** Loaded lazily and only on a device. The Cordova plugin reaches for
 *  `window.cordova` at import time, which does not exist in the browser build
 *  or under vitest. */
type OneSignalModule = typeof import('onesignal-cordova-plugin').default;
let plugin: OneSignalModule | null = null;

async function oneSignal(): Promise<OneSignalModule | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (plugin) return plugin;
  try {
    plugin = (await import('onesignal-cordova-plugin')).default;
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

export async function setExternalUserId(userId: string): Promise<void> {
  const os = await oneSignal();
  os?.login(userId);
}

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

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
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
