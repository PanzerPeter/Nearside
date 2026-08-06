import { useEffect } from 'react';

/**
 * The two Badging API methods this hook needs. Not in lib.dom.d.ts (the API
 * is Chromium/iOS-only and never made it into the TS DOM lib), so narrow
 * `Navigator` onto this shape locally rather than reaching for `any`.
 */
interface NavigatorWithBadge extends Navigator {
  setAppBadge(count: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

/**
 * Mirror the total unread count onto the installed app's icon. Unsupported
 * everywhere except installed PWAs on Chromium and iOS 16.4+, so every call is
 * guarded and failure is silent — a rejected promise here must never surface.
 */
export function useAppBadge(total: number): void {
  useEffect(() => {
    // Both names are checked, not just the one about to be called: a browser
    // shipping one half of the pair would throw synchronously, which no
    // .catch() can absorb.
    if (!('setAppBadge' in navigator) || !('clearAppBadge' in navigator)) return;
    const badgedNavigator = navigator as NavigatorWithBadge;

    if (total > 0) {
      badgedNavigator.setAppBadge(total).catch(() => {});
    } else {
      badgedNavigator.clearAppBadge().catch(() => {});
    }
  }, [total]);
}
