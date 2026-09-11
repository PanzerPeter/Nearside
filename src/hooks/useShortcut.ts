// One window listener per component that has a shortcut to answer.
//
// Deliberately not a central dispatcher with a registry. Every shortcut this
// app has belongs to whichever component already owns the state it changes —
// the chat list owns the selection and the archive flag, the conversation owns
// its search — and routing them through a bus would mean each of those
// exporting a handle for something it can already do itself.
//
// The handler answers whether it took the keystroke. Only then is the browser's
// own behaviour suppressed: Ctrl+F must stay the find bar on any screen where
// this app has no search to offer.

import { useEffect, useRef } from 'react';
import { shortcutFor, type Shortcut } from '../lib/shortcuts';

/**
 * @param handle return true if the shortcut was acted on, false to let it
 *   through to the browser
 * @param enabled false while the component is on screen but not in a position
 *   to act — a conversation behind the lock screen, say
 */
export function useShortcut(handle: (shortcut: Shortcut) => boolean, enabled = true): void {
  // Through a ref so the listener is bound once: `handle` closes over state and
  // is a fresh arrow on every render, and re-binding per render would add and
  // remove a window listener on every keystroke in the composer.
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      const shortcut = shortcutFor(e);
      if (!shortcut) return;
      if (!handleRef.current(shortcut)) return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
