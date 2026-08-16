import { useEffect, useRef } from 'react';

/** Each claimed entry gets a number, and they only ever go up. Landing on a
 *  lower one means everything above it was popped. */
let nextId = 1;

/**
 * Makes hardware/browser back dismiss a full-screen phone view instead of
 * leaving the app: pushes one history entry while the view is open and closes
 * the view when that entry is popped.
 *
 * Nests. A settings subpage sits on top of the settings tab, so one press must
 * close one view — but `popstate` is a window event that every live view hears,
 * and a view closed from the UI has to consume its own entry with a
 * `history.back()` that looks exactly like a press. Both are answered by
 * reading the entry the browser landed on rather than the event: a view closes
 * only when the current id is below its own, which is true when its entry was
 * popped and false when it is still sitting there underneath something else.
 *
 * Single-pane only. On the desktop layout the panes it guards (the open
 * conversation, the settings tab) are not full-screen takeovers, so "back"
 * dismissing one would be surprising rather than expected.
 */
export function useMobileBackClose(active: boolean, onClose: () => void) {
  // Read through a ref so a fresh inline arrow from the caller on every render
  // doesn't re-run the effect — which would push a second entry and consume it,
  // making the *first* back press a no-op.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    if (!window.matchMedia('(max-width: 1023px)').matches) return;

    const id = nextId++;
    window.history.pushState({ nearsideBack: true, nearsideBackId: id }, '');

    const onPop = () => {
      const landed = window.history.state?.nearsideBackId;
      // Our entry is still on the stack, so the press was aimed at something
      // above us — or it was the subpage above us consuming its own entry on
      // its way out. Either way it is not ours to answer.
      if (typeof landed === 'number' && landed >= id) return;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed from the UI rather than by a back navigation: our entry is still
      // the current one, so consume it or the next back press would be a no-op.
      // After a real press the current entry belongs to somebody else and going
      // back again would take a screen the user did not ask for.
      if (window.history.state?.nearsideBackId === id) window.history.back();
    };
  }, [active]);
}
