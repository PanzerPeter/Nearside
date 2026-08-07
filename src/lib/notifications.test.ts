import { describe, expect, it } from 'vitest';

import { resolveOneSignal } from './notifications';

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
