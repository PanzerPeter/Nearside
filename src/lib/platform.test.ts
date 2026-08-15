import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlatform = vi.fn();
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => getPlatform() } }));

const { isDesktop, isMobileNative } = await import('./platform');

beforeEach(() => getPlatform.mockReset());

describe('isMobileNative', () => {
  it('is true on the two shipping targets', () => {
    getPlatform.mockReturnValue('android');
    expect(isMobileNative()).toBe(true);
    getPlatform.mockReturnValue('ios');
    expect(isMobileNative()).toBe(true);
  });

  it('is false on Electron', () => {
    // The whole reason this module exists. `Capacitor.isNativePlatform()`
    // returns TRUE here, and every call site that trusted it would take a
    // branch the desktop shell cannot honour — writing the identity seed to
    // localStorage while the UI claims hardware-backed storage, opening a
    // SQLite mirror with no driver, and calling OneSignal, RevenueCat and the
    // local ScreenGuard plugin, none of which exist on Electron.
    getPlatform.mockReturnValue('electron');
    expect(isMobileNative()).toBe(false);
  });

  it('is false in a browser', () => {
    getPlatform.mockReturnValue('web');
    expect(isMobileNative()).toBe(false);
  });

  it('is false on a platform nobody has added yet', () => {
    // Fails closed. A future shell should degrade to the browser path rather
    // than inherit mobile capabilities by default.
    getPlatform.mockReturnValue('windows');
    expect(isMobileNative()).toBe(false);
  });
});

describe('isDesktop', () => {
  it('names Electron and nothing else', () => {
    getPlatform.mockReturnValue('electron');
    expect(isDesktop()).toBe(true);
    for (const other of ['android', 'ios', 'web']) {
      getPlatform.mockReturnValue(other);
      expect(isDesktop()).toBe(false);
    }
  });
});
