// Web Push (background notification) helpers. Everything here degrades
// gracefully: on browsers without Push support (e.g. iOS Safari outside an
// installed PWA) `pushSupported()` is false and the app simply relies on the
// foreground sound + notification path instead.

import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from './vapid';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    !!VAPID_PUBLIC_KEY
  );
}

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
 * Persist a subscription for the signed-in user.
 *
 * Takes the JSON form rather than the `PushSubscription` object so the service
 * worker's `pushsubscriptionchange` handler can hand one over by postMessage —
 * the SW has no Supabase session of its own, so re-registering a rotated
 * endpoint has to happen here.
 */
export async function storeSubscriptionJSON(
  session: Session,
  json: PushSubscriptionJSON
): Promise<void> {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return;

  await supabase.from('push_subscriptions').upsert(
    {
      user_id: session.user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: navigator.userAgent.slice(0, 300),
    },
    { onConflict: 'endpoint' }
  );
}

async function storeSubscription(session: Session, sub: PushSubscription): Promise<void> {
  await storeSubscriptionJSON(session, sub.toJSON());
}

/**
 * Ensure this device is subscribed and the subscription is stored for the
 * current user. Assumes notification permission is already granted.
 */
export async function subscribeToPush(session: Session): Promise<boolean> {
  if (!pushSupported() || notificationPermission() !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
      }));

    await storeSubscription(session, sub);
    return true;
  } catch {
    return false;
  }
}

export interface EnablePushResult {
  permission: NotificationPermission;
  /** Whether this device actually holds a stored push subscription now. */
  subscribed: boolean;
}

/**
 * Request permission (if needed) and subscribe.
 *
 * Reports both halves: granting permission does not imply a subscription
 * exists. Where Push is unavailable but Notification is not (Safari outside an
 * installed PWA, or a build with no VAPID key) permission goes to 'granted'
 * while `subscribeToPush` quietly fails — reporting only the permission made
 * the UI claim background notifications that will never arrive.
 */
export async function enablePush(session: Session): Promise<EnablePushResult> {
  const permission = await requestNotificationPermission();
  if (permission !== 'granted') return { permission, subscribed: false };
  return { permission, subscribed: await subscribeToPush(session) };
}

/** Unsubscribe this device and forget its stored subscription. */
export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  } catch {
    /* best effort */
  }
}

/**
 * On app start (after login): if the user has already granted permission,
 * silently refresh the subscription so it stays registered for this user.
 */
export async function syncPushSubscription(session: Session): Promise<void> {
  if (pushSupported() && notificationPermission() === 'granted') {
    await subscribeToPush(session);
  }
}

/**
 * Dismiss any notifications already shown for a conversation.
 *
 * Opening a chat is the user reading it, so leaving three stacked "@alice"
 * banners in the OS tray afterwards is noise — and worse, on desktop they keep
 * the app icon lit for messages that are visibly on screen. Matched by the
 * same `dm:<senderId>` tag both the foreground path and the push payload use.
 */
export async function closeNotificationsFor(tag: string): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const shown = await registration.getNotifications({ tag });
    for (const notification of shown) notification.close();
  } catch {
    /* getNotifications is unimplemented on some browsers; nothing to clean up */
  }
}
