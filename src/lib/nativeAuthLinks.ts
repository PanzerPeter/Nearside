import { App } from '@capacitor/app';
import { supabase } from './supabase';
import { parseAuthLink } from './deepLink';

/**
 * Device-side half of the email-link flow: GoTrue redirects to
 * `app.nearside://auth/...`, Android hands the URL to the app, and this turns
 * the PKCE code in it into a session.
 *
 * `exchangeCodeForSession` also emits `PASSWORD_RECOVERY` rather than
 * `SIGNED_IN` when the code came from a reset, because auth-js stores the
 * redirect type alongside the code verifier — so `useAuth` routes the user to
 * `SetNewPassword` with no help from here.
 */

type ErrorListener = (message: string) => void;

const listeners = new Set<ErrorListener>();

/**
 * A link is tapped in a mail client, not in the app, so a failure has no call
 * stack to return to. Subscribers exist to put the reason on screen instead of
 * leaving the user staring at an unchanged sign-in form.
 */
export function subscribeToAuthLinkError(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function report(message: string) {
  for (const listener of listeners) listener(message);
}

/** Returns whether the URL was one of ours, handled or not. */
export async function handleAuthLink(url: string): Promise<boolean> {
  const link = parseAuthLink(url);
  if (!link) return false;

  if (link.status === 'error') {
    report(link.message);
    return true;
  }

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(link.code);
    if (error) report(error.message);
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  }
  return true;
}

/**
 * Wires both delivery paths. A link tapped while the app is running arrives as
 * an `appUrlOpen` event; one tapped while it is killed arrives only as the
 * launch intent, and handling just the former is the usual way a deep link
 * ships half-working.
 */
export function registerAuthLinkHandler(): void {
  void App.addListener('appUrlOpen', ({ url }) => {
    void handleAuthLink(url);
  });

  void App.getLaunchUrl().then((launch) => {
    if (launch?.url) void handleAuthLink(launch.url);
  });
}
