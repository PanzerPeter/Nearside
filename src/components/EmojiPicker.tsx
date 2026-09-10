import { useEffect, useRef } from 'react';
import { Picker } from 'emoji-mart';
import data from '@emoji-mart/data';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  /**
   * Called when emoji-mart detects a click outside its own root. Receives the
   * native event so the caller can ignore clicks on the trigger button (which
   * otherwise close the picker on the very click that opened it).
   */
  onClickOutside: (e: MouseEvent) => void;
}

/**
 * emoji-mart's picker is a custom element (`em-emoji-picker`), not a React
 * component: it is constructed imperatively and appends itself to whatever
 * node it is handed. This file is the adapter.
 *
 * It used to be `@emoji-mart/react`, whose entire contents were the twenty
 * lines below. That package was last published in January 2023 and still
 * declares `react@^16.8 || ^17 || ^18`, which made a two-year-old wrapper the
 * only thing pinning the app to React 18. Inlining it costs nothing — the
 * types it shipped were `props: any` — and the peer range goes with it.
 */
/**
 * Light or dark, from the theme the user actually chose.
 *
 * `data-surface` is set by `applyTheme` off the active pack's `color-scheme`,
 * which is the same signal the system bars and the elevation tokens read. The
 * picker used to be constructed with a hardcoded `theme: 'dark'`, so somebody
 * on a light pack opened a black panel in the middle of a cream app — the one
 * surface in Nearside that ignored the theme store it was sold from.
 */
function surface(): 'light' | 'dark' {
  return document.documentElement.dataset.surface === 'light' ? 'light' : 'dark';
}

export default function EmojiPicker({ onSelect, onClickOutside }: EmojiPickerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = surface();

  // The picker keeps the callbacks it was constructed with, and it is
  // constructed once. Reading them out of a ref at call time is what stops the
  // panel from going on calling the `onClose` captured on the render that
  // mounted it — the popover would stop closing the moment its parent
  // re-rendered with a new one. The upstream wrapper solved this by calling
  // `update(props)` during render instead; a ref does it without a
  // side effect in the render phase.
  const callbacks = useRef({ onSelect, onClickOutside });
  useEffect(() => {
    callbacks.current = { onSelect, onClickOutside };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // `ref` is emoji-mart's own prop, not React's: the constructor reads
    // `.current` off it, empties that node and appends itself to it.
    new Picker({
      data,
      theme,
      previewPosition: 'none',
      // In the search row rather than 'none'. A picker that cannot be set to
      // your own skin tone hands back a default one every time, which is the
      // kind of small wrongness people notice in every message they send;
      // emoji-mart remembers the choice itself.
      skinTonePosition: 'search',
      dynamicWidth: true,
      onEmojiSelect: (e: { native: string }) => callbacks.current.onSelect(e.native),
      onClickOutside: (e: MouseEvent) => callbacks.current.onClickOutside(e),
      ref: hostRef,
    });

    // Removing the element fires its `disconnectedCallback`, which is where
    // emoji-mart unregisters its own listeners. React unmounting the host div
    // would get there too, but not on StrictMode's discarded first pass, which
    // re-runs this effect against a host that is still mounted.
    return () => host.replaceChildren();
    // Rebuilt when the surface flips, which is the only way a constructed-once
    // custom element can follow a theme change. Rare enough that losing the
    // panel's scroll position costs nothing.
  }, [theme]);

  return <div ref={hostRef} />;
}
