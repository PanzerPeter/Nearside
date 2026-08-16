// Whether this app is in front of the user, from the one source per shell that
// actually knows.
//
// Presence used to answer this with `document.visibilityState` plus
// `document.hasFocus()`. In a browser that is right. Inside an Android WebView
// it is not: the WebView routinely reports no focus while somebody is typing
// into it, so the app broadcast "away" to every peer during ordinary use and
// the amber dot became the normal state on a phone. The OS already answers this
// exactly, through Capacitor's `appStateChange`, so on Android and iOS the DOM
// is not consulted at all.

import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { isMobileNative } from './platform';

let active = true;
let stop: (() => void) | null = null;
const listeners = new Set<(active: boolean) => void>();

function set(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener(active);
}

/** The browser's answer: in front means visible *and* focused, so another
 *  window on top of this one counts as away. */
function domActive(): boolean {
  if (typeof document === 'undefined') return true;
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  return document.visibilityState === 'visible' && focused;
}

function start(): void {
  if (isMobileNative()) {
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    // `getState` because a listener alone says nothing until the next
    // transition, and the app may have started in the background (a push woke
    // it) where reporting "active" would be a lie told to every peer.
    void App.getState()
      .then(({ isActive }) => set(isActive))
      .catch(() => {});
    void App.addListener('appStateChange', ({ isActive }) => set(isActive)).then((h) => {
      if (cancelled) void h.remove();
      else handle = h;
    });
    stop = () => {
      cancelled = true;
      void handle?.remove();
    };
    return;
  }

  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const onChange = () => set(domActive());
  set(domActive());
  document.addEventListener('visibilitychange', onChange);
  window.addEventListener('focus', onChange);
  window.addEventListener('blur', onChange);
  stop = () => {
    document.removeEventListener('visibilitychange', onChange);
    window.removeEventListener('focus', onChange);
    window.removeEventListener('blur', onChange);
  };
}

/** Whether the app is in front right now. Meaningful once something has
 *  subscribed — nothing polls the shell on its own. */
export function isAppActive(): boolean {
  return active;
}

/** Watch for the app moving to and from the front. The underlying listeners
 *  are shared and torn down with the last subscriber. */
export function subscribeAppActive(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}
