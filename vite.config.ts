import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// package.json is the one place the version is written; the Android
// versionName, the Electron package and this define all follow it, and
// src/lib/version.test.ts fails the suite when one of them drifts.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;

export default defineConfig(() => {
  // Set by the android:sync script. A Workbox precache inside a WebView serves
  // the previous build after an app update, which reads as "my change didn't
  // apply" rather than as a caching bug.
  const native = process.env.NEARSIDE_NATIVE === '1';

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
    },
    plugins: [
      react(),
      VitePWA({
        // The plugin stays in the graph even for native builds — it owns the
        // `virtual:pwa-register/react` module that UpdatePrompt imports, and
        // `disable` swaps that for a no-op stub. Dropping the plugin outright
        // breaks the native build at import resolution instead.
        disable: native,
        registerType: 'prompt',
        // Custom service worker so we can add Web Push handlers on top of the
        // Workbox precache. See src/sw.ts.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        },
        manifest: {
          name: 'Nearside',
          short_name: 'Nearside',
          description: 'Private messages that stay yours.',
          theme_color: '#1a1b1e',
          background_color: '#1a1b1e',
          display: 'standalone',
          orientation: 'portrait',
          scope: '/',
          start_url: '/',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
      }),
    ],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('/node_modules/@supabase/')) return 'supabase';
            if (id.includes('/node_modules/react')) return 'react';
          },
        },
      },
    },
  };
});
