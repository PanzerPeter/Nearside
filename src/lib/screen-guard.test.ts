import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({
    enable: () => Promise.reject(new Error('not implemented on web')),
    disable: () => Promise.reject(new Error('not implemented on web')),
  }),
}));

describe('setScreenGuard', () => {
  it('resolves without calling the plugin off a device', async () => {
    const { setScreenGuard } = await import('./screen-guard');
    await expect(setScreenGuard(true)).resolves.toBeUndefined();
    await expect(setScreenGuard(false)).resolves.toBeUndefined();
  });
});
