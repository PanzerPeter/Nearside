/// <reference lib="webworker" />
//
// Custom Chatly service worker (vite-plugin-pwa `injectManifest`).
// Keeps the Workbox app-shell precache + SPA navigation fallback, and adds
// Web Push handlers so messages notify the receiver even when the app is closed.

import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { VAPID_PUBLIC_KEY, urlBase64ToUint8Array } from './lib/vapid';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

interface PushPayload {
  title?: string;
  body?: string;
  tag?: string;
  data?: { url?: string; senderId?: string };
}

/**
 * `NotificationOptions` in lib.dom is missing the fields every real push
 * implementation supports. `renotify` in particular is load-bearing here: the
 * payload reuses one tag per sender so a conversation collapses into a single
 * banner, but without `renotify` that reuse also means each further message
 * *silently* replaces the last — no sound, no buzz, no re-alert. Which is
 * precisely the "notifications don't work properly" complaint.
 */
interface RichNotificationOptions extends NotificationOptions {
  renotify?: boolean;
  vibrate?: number[];
  timestamp?: number;
}

// Precache everything the build injected into the manifest.
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback -> index.html, except API/auth paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api/, /^\/auth/],
  })
);

// Prompt-style updates: the app posts SKIP_WAITING when the user clicks "Reload".
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ---- Web Push ----
self.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() };
  }

  const senderId = payload.data?.senderId;
  const tag = payload.tag ?? (senderId ? `dm:${senderId}` : undefined);
  const options: RichNotificationOptions = {
    body: payload.body || 'New message',
    tag,
    // Only meaningful alongside a tag, and rejected without one on some
    // engines — so it tracks whether we actually have one.
    renotify: !!tag,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    vibrate: [90, 50, 90],
    timestamp: Date.now(),
    // Land the user in the conversation the message came from rather than on
    // whatever chat happened to be open last.
    data: {
      ...(payload.data ?? {}),
      url: senderId ? `/?chat=${senderId}` : (payload.data?.url ?? '/'),
      senderId,
    },
  };

  event.waitUntil(self.registration.showNotification(payload.title || 'Chatly', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string; senderId?: string };
  const targetUrl = data.url || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of windows) {
        // Reuse an already-open Chatly window rather than opening a new one.
        // A bare `focus()` used to drop the user wherever they left off; the
        // message tells the running app which conversation to open, since a
        // focused SPA won't re-read the URL on its own.
        if (data.senderId) {
          client.postMessage({ type: 'OPEN_CHAT', senderId: data.senderId });
        }
        await client.focus();
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});

/**
 * Push services rotate endpoints (Chrome does it routinely, and it also fires
 * after a long offline stretch). The old endpoint then 410s and the device
 * silently stops receiving notifications until the user happens to reopen
 * Settings. Re-subscribe immediately and hand the new endpoint to any running
 * tab, which has the Supabase session needed to persist it; if no tab is open,
 * the app's next start re-registers it through `syncPushSubscription`.
 *
 * Cast because `pushsubscriptionchange` is absent from lib.webworker's event
 * map, not because the event is exotic — it is part of the Push API.
 */
self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      if (!VAPID_PUBLIC_KEY) return;
      try {
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        const windows = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windows) {
          client.postMessage({
            type: 'PUSH_SUBSCRIPTION_CHANGED',
            subscription: sub.toJSON(),
          });
        }
      } catch {
        /* the app re-subscribes on next start */
      }
    })()
  );
}) as EventListener);
