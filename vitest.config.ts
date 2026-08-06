import { defineConfig } from 'vitest/config';

// Standalone from vite.config.ts on purpose — the PWA plugin emits a service
// worker whenever its config is loaded, which a test run has no use for.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
