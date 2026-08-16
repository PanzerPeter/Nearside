import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ native: false }));
vi.mock('./platform', () => ({ isMobileNative: () => platform.native }));

const nativeApp = vi.hoisted(() => ({
  handlers: [] as ((state: { isActive: boolean }) => void)[],
  removed: 0,
  state: true,
}));
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (_event: string, handler: (state: { isActive: boolean }) => void) => {
      nativeApp.handlers.push(handler);
      return {
        remove: async () => {
          nativeApp.removed += 1;
        },
      };
    },
    getState: async () => ({ isActive: nativeApp.state }),
  },
}));

import { isAppActive, subscribeAppActive } from './app-active';

/** Whatever the page would say about itself, so the native cases can prove
 *  they ignore it. */
function stubDom({ visible, focused }: { visible: boolean; focused: boolean }) {
  const events = new Map<string, Set<() => void>>();
  const add = (type: string, fn: () => void) => {
    if (!events.has(type)) events.set(type, new Set());
    events.get(type)!.add(fn);
  };
  const remove = (type: string, fn: () => void) => events.get(type)?.delete(fn);
  const g = globalThis as Record<string, unknown>;
  g.document = {
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => focused,
    addEventListener: add,
    removeEventListener: remove,
  };
  g.window = { addEventListener: add, removeEventListener: remove };
  return {
    fire: (type: string) => {
      for (const fn of events.get(type) ?? []) fn();
    },
    set: (next: { visible?: boolean; focused?: boolean }) => {
      const doc = g.document as { visibilityState: string; hasFocus: () => boolean };
      if (next.visible !== undefined) doc.visibilityState = next.visible ? 'visible' : 'hidden';
      if (next.focused !== undefined) doc.hasFocus = () => next.focused!;
    },
  };
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.document;
  delete g.window;
  nativeApp.handlers.length = 0;
  nativeApp.removed = 0;
  nativeApp.state = true;
});

describe('on a phone', () => {
  beforeEach(() => {
    platform.native = true;
  });

  it('reports active from the OS state even when the WebView claims no focus', async () => {
    // The bug this module exists for: an Android WebView routinely answers
    // `hasFocus()` with false while the user is typing into it, which used to
    // broadcast "away" to every peer.
    stubDom({ visible: true, focused: false });
    const unsubscribe = subscribeAppActive(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(isAppActive()).toBe(true);
    unsubscribe();
  });

  it('follows the app moving to the background and back', async () => {
    stubDom({ visible: true, focused: true });
    const seen: boolean[] = [];
    const unsubscribe = subscribeAppActive((a) => seen.push(a));
    await Promise.resolve();

    for (const handler of nativeApp.handlers) handler({ isActive: false });
    expect(isAppActive()).toBe(false);
    for (const handler of nativeApp.handlers) handler({ isActive: true });

    expect(seen).toEqual([false, true]);
    unsubscribe();
  });

  it('says nothing when the state repeats', async () => {
    stubDom({ visible: true, focused: true });
    const seen: boolean[] = [];
    const unsubscribe = subscribeAppActive((a) => seen.push(a));
    await Promise.resolve();

    for (const handler of nativeApp.handlers) handler({ isActive: true });
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it('drops the OS listener once the last subscriber leaves', async () => {
    stubDom({ visible: true, focused: true });
    const unsubscribe = subscribeAppActive(() => {});
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();
    await Promise.resolve();

    expect(nativeApp.removed).toBe(1);
  });
});

describe('in a browser', () => {
  beforeEach(() => {
    platform.native = false;
  });

  it('needs the page both visible and focused', () => {
    const dom = stubDom({ visible: true, focused: false });
    const unsubscribe = subscribeAppActive(() => {});
    expect(isAppActive()).toBe(false);

    dom.set({ focused: true });
    dom.fire('focus');
    expect(isAppActive()).toBe(true);

    dom.set({ visible: false });
    dom.fire('visibilitychange');
    expect(isAppActive()).toBe(false);
    unsubscribe();
  });

  it('stops listening once the last subscriber leaves', () => {
    const dom = stubDom({ visible: true, focused: true });
    const seen: boolean[] = [];
    const unsubscribe = subscribeAppActive((a) => seen.push(a));
    // Subscribing can itself report a correction, if the shared flag was stale.
    const atUnsubscribe = seen.length;
    unsubscribe();

    dom.set({ focused: false });
    dom.fire('blur');
    expect(seen.length).toBe(atUnsubscribe);
  });
});
