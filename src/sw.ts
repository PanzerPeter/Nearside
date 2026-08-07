/// <reference lib="webworker" />
//
// Custom Nearside service worker (vite-plugin-pwa `injectManifest`).
//
// Workbox app-shell precache plus the SPA navigation fallback, and nothing
// else. The Web Push handlers that used to live here are gone: background
// notifications are OneSignal's job on Android, and the service worker only
// runs in the browser build, which is a development convenience rather than a
// target. Two transports competing for one tray entry was the bug.

import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

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
