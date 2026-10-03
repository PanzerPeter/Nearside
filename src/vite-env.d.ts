/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />
/// <reference types="vite-plugin-pwa/client" />

// Substituted by the `define` in vite.config.ts (and its twin in
// vitest.config.ts) from package.json's version.
declare const __APP_VERSION__: string;

// True in the F-Droid build (`vite build --mode foss`), which ships without
// OneSignal, RevenueCat, ML Kit and Crashlytics. Ask `lib/platform.ts`
// rather than reading this directly.
declare const __FOSS__: boolean;
