import { useEffect, useRef } from 'react';

/**
 * Makes hardware/browser back dismiss a full-screen phone view instead of
 * leaving the app: pushes one history entry while the view is open and closes
 * the view when that entry is popped.
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

    window.history.pushState({ nearsideBack: true }, '');
    const onPop = () => onCloseRef.current();
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed from the UI rather than by a back navigation: our entry is still
      // on the stack, so consume it or the next back press would be a no-op.
      if (window.history.state?.nearsideBack) window.history.back();
    };
  }, [active]);
}
