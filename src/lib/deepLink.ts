/**
 * Parsing for the `app.nearside://auth/*` links that GoTrue redirects to after
 * an email confirmation or a password reset.
 *
 * Deliberately free of any Capacitor import: this is string work, so it runs
 * and is tested under plain node. `nativeAuthLinks.ts` is the thin shell that
 * feeds it URLs from the device.
 */

const SCHEME = 'app.nearside:';
const HOST = 'auth';

/**
 * Which email started the flow. PKCE hands back an opaque `?code=` that looks
 * identical for both, and `exchangeCodeForSession` reports `SIGNED_IN` either
 * way — so the path is the only thing telling a password reset apart from a
 * signup confirmation. Without it, a reset drops the user into the app with no
 * route to `SetNewPassword`.
 */
export type AuthLinkKind = 'confirm' | 'recovery';

export type AuthLink =
  | { kind: AuthLinkKind; status: 'ok'; code: string }
  | { kind: AuthLinkKind; status: 'error'; message: string };

const KINDS: Record<string, AuthLinkKind> = {
  '/confirm': 'confirm',
  '/recovery': 'recovery',
};

/**
 * Returns the auth intent behind a deep link, or `null` if the URL is not one
 * of ours. `null` means "not for us, ignore it" — every non-auth deep link the
 * app might grow later lands here too, so it must never throw.
 */
export function parseAuthLink(url: string): AuthLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== SCHEME || parsed.hostname !== HOST) return null;

  const path = parsed.pathname.replace(/\/$/, '');
  const kind = KINDS[path];
  if (!kind) return null;

  // GoTrue puts the outcome in the query on the PKCE path and in the fragment
  // on others. Reading both costs nothing and keeps an expired link from
  // arriving as silence.
  const query = parsed.searchParams;
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const param = (name: string) => query.get(name) ?? fragment.get(name);

  const error = param('error');
  if (error) {
    return { kind, status: 'error', message: param('error_description') ?? error };
  }

  const code = param('code');
  if (code) return { kind, status: 'ok', code };

  return null;
}
