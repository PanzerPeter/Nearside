import { describe, expect, it } from 'vitest';

import { pushBlockedByOs, resolveOneSignal, shouldOfferPush } from './notifications';

/**
 * The shape of the OneSignal Cordova plugin as it actually arrives in the
 * bundle, captured from the running Android WebView.
 *
 * `onesignal-cordova-plugin` is `"type": "module"` with a CommonJS `main`, so
 * the bundler wraps it: the ES namespace's `default` is the whole CJS exports
 * object, and the plugin instance sits one level further down at
 * `.default.default`. Reading `.default` alone hands back a bag of classes with
 * no `initialize` on it, and because every call in this module is wrapped in a
 * try/catch, that failure was completely silent.
 */
function bundledNamespace() {
  const instance = { initialize: () => {}, login: () => {}, logout: () => {} };
  return {
    default: {
      LogLevel: {},
      OSNotification: class {},
      OneSignalPlugin: class {},
      default: instance,
    },
  };
}

/** What a plain ES module, or a bundler that unwraps the interop itself,
 *  produces: the instance directly under `default`. */
function plainNamespace() {
  const instance = { initialize: () => {}, login: () => {}, logout: () => {} };
  return { default: instance };
}

describe('resolveOneSignal', () => {
  it('finds the plugin behind the doubled default of the bundled CJS module', () => {
    const ns = bundledNamespace();
    expect(resolveOneSignal(ns)).toBe(ns.default.default);
  });

  it('finds the plugin under a single default', () => {
    const ns = plainNamespace();
    expect(resolveOneSignal(ns)).toBe(ns.default);
  });

  it('accepts the plugin instance handed over directly', () => {
    const instance = { initialize: () => {}, login: () => {} };
    expect(resolveOneSignal(instance)).toBe(instance);
  });

  it('returns null rather than a half-plugin when no initialize is reachable', () => {
    // Better to report "no plugin" and let the caller stay honest about it than
    // to hand back an object whose every method is undefined.
    expect(resolveOneSignal({ default: { LogLevel: {} } })).toBeNull();
    expect(resolveOneSignal(null)).toBeNull();
    expect(resolveOneSignal(undefined)).toBeNull();
    expect(resolveOneSignal('nope')).toBeNull();
  });

  it('does not loop forever on a module that defaults to itself', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.default = cyclic;
    expect(resolveOneSignal(cyclic)).toBeNull();
  });
});

describe('shouldOfferPush', () => {
  const fresh = { native: true, granted: false, canRequest: true, alreadyAsked: false };

  it('offers on a fresh install, which is the whole point of it', () => {
    expect(shouldOfferPush(fresh)).toBe(true);
  });

  it('never offers twice', () => {
    // "Not now" has to mean not now. A permission card that returns on the
    // next launch is the pattern that teaches people to deny by reflex.
    expect(shouldOfferPush({ ...fresh, alreadyAsked: true })).toBe(false);
  });

  it('stays quiet when notifications are already on', () => {
    expect(shouldOfferPush({ ...fresh, granted: true })).toBe(false);
  });

  it('stays quiet when Android will no longer show a prompt', () => {
    // Offering to ask when the OS has stopped listening produces a card whose
    // button does nothing.
    expect(shouldOfferPush({ ...fresh, canRequest: false })).toBe(false);
  });

  it('stays quiet off-device, where there is no OneSignal at all', () => {
    expect(shouldOfferPush({ ...fresh, native: false })).toBe(false);
  });
});

describe('pushBlockedByOs', () => {
  it('is true only once Android has stopped offering the prompt', () => {
    // This is what decides whether the app says "tap to turn on" or sends the
    // user to system settings. Getting it backwards is what made the toggle
    // read as broken: it pointed at Settings while a tap would have prompted.
    expect(pushBlockedByOs({ granted: false, canRequest: false })).toBe(true);
    expect(pushBlockedByOs({ granted: false, canRequest: true })).toBe(false);
  });

  it('is false when permission is already granted, whatever canRequest says', () => {
    expect(pushBlockedByOs({ granted: true, canRequest: false })).toBe(false);
  });
});
