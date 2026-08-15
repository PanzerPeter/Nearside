import type { AuthLinkKind } from './deepLink';
import { isMobileNative } from './platform';

/**
 * Where GoTrue should send the user after they click an emailed link.
 *
 * On the device this has to be the custom scheme: Capacitor serves the bundle
 * from `http://localhost`, so `window.location.origin` — which is what the web
 * build wants — resolves to a port nothing is listening on once the link
 * leaves the app for the mail client.
 *
 * Returns `undefined` rather than an empty string when there is no window, so
 * the caller omits the option entirely and GoTrue falls back to the project's
 * Site URL.
 */
export function authRedirectTo(kind: AuthLinkKind): string | undefined {
  if (isMobileNative()) return `app.nearside://auth/${kind}`;
  if (typeof window === 'undefined') return undefined;
  return window.location.origin;
}
