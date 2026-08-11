import { defineConfig } from 'vitest/config';

// Standalone from vite.config.ts on purpose — the PWA plugin emits a service
// worker whenever its config is loaded, which a test run has no use for.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `lib/supabase.ts` throws at module scope when these are unset, and half
    // the suite imports something that imports it. Without these the run passes
    // only on a machine that happens to have a `.env` — which is why CI, a
    // fresh clone, and a container all failed while a developer's checkout did
    // not. Deliberately unusable values: they take priority over a real `.env`,
    // so a unit test can never reach the live project.
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
});
