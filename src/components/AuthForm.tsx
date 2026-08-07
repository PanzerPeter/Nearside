import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { authRedirectTo } from '../lib/authRedirect';
import { subscribeToAuthLinkError } from '../lib/nativeAuthLinks';
import { LegalFooter } from './LegalFooter';
import { BrandMark } from './BrandMark';
import { LogIn, UserPlus } from 'lucide-react';

/** Display names are not addresses: they may collide, contain spaces and keep
 *  their capitals. All that is enforced is that there is something there and
 *  that it fits on a row. The old ^[a-z0-9_]{3,24}$ handle format went with the
 *  unique constraint in 0022 — a namespace is enumerable, and that is exactly
 *  what this product is removing. */
const DISPLAY_NAME_MAX = 32;

// Shared field styling — one source of truth for the four inputs so the focus
// treatment (blue border + soft ring, no default outline) stays consistent.
const INPUT_CLASS =
  'input w-full bg-base-200/50 border border-base-content/10 focus:border-primary focus:bg-base-200 focus:outline-none focus:ring-2 focus:ring-primary/25 transition-all';

const LABEL_CLASS =
  'label-text text-xs font-medium uppercase tracking-wider text-base-content/60';

export function AuthForm() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [display_name, setUsername] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  // An emailed link that failed fails while the user is in their mail client,
  // so the sign-in screen is where they land and the only place the reason can
  // reach them.
  useEffect(() => subscribeToAuthLinkError(setError), []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');

    if (isSignUp) {
      // Trimmed but not lowercased: the name is shown as the person wrote it.
      const normalized = display_name.trim();
      if (!normalized || normalized.length > DISPLAY_NAME_MAX) {
        setError(`Enter a display name, up to ${DISPLAY_NAME_MAX} characters.`);
        return;
      }
      setLoading(true);
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { display_name: normalized },
          emailRedirectTo: authRedirectTo('confirm'),
        },
      });
      setLoading(false);

      if (signUpError) {
        // GoTrue generally does not propagate a signup-trigger's Postgres
        // error text to the client — it collapses trigger failures to a
        // generic "Database error saving new user" and logs the real cause
        // server-side. Display names no longer have to be unique, so the only
        // remaining collision worth naming is the email.
        const raw = signUpError.message;
        setError(
          /duplicate|already|unique|database error/i.test(raw)
            ? "Couldn't create the account. That email may already be registered."
            : raw
        );
        return;
      }
      // Email confirmation on: a user exists but no active session yet.
      if (data.user && !data.session) {
        setNotice('Check your email to confirm your account, then sign in.');
        setIsSignUp(false);
      }
      return;
    }

    setLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);
    if (signInError) setError(signInError.message);
  }

  async function handleForgotPassword() {
    setError('');
    setNotice('');
    const target = email.trim();
    if (!target) {
      setError('Enter your email above first, then tap “Forgot password?”.');
      return;
    }
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: authRedirectTo('recovery'),
    });
    setLoading(false);
    if (resetError) setError(resetError.message);
    else setNotice('Password reset link sent. Check your email.');
  }

  return (
    <div className="relative min-h-dvh flex flex-col items-center justify-center gap-4 bg-base-300 px-4 py-6 overflow-hidden">
      {/* Ambient brand glow — adds depth behind the card without competing with it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60rem 40rem at 50% -10%, rgba(59,130,246,0.10), transparent 70%)',
        }}
      />
      <div className="relative card w-full max-w-sm bg-base-100 shadow-2xl border border-base-content/5">
        <div className="card-body p-6 sm:p-8">
          <div className="flex flex-col items-center gap-2.5 mb-1">
            <div className="relative">
              <div
                aria-hidden
                className="absolute inset-0 -z-10 blur-xl opacity-50"
                style={{ background: 'radial-gradient(closest-side, rgba(59,130,246,0.55), transparent)' }}
              />
              <BrandMark size={44} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-base-content">Nearside</h1>
          </div>
          <p className="text-center text-base-content/60 text-sm mb-6">
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <div className="form-control">
                <label className="label pb-1">
                  <span className={LABEL_CLASS}>Display name</span>
                </label>
                {/* No pattern and no minimum: a display name is not a handle.
                    Spaces, capitals and accents are all fine, and two people
                    may pick the same one — that is what stops it being an
                    address. The only rule left is the length cap. */}
                <input
                  type="text"
                  placeholder="Jane Doe"
                  className={INPUT_CLASS}
                  value={display_name}
                  onChange={(e) => setUsername(e.target.value)}
                  required={isSignUp}
                  maxLength={DISPLAY_NAME_MAX}
                  autoComplete="name"
                />
              </div>
            )}

            <div className="form-control">
              <label className="label pb-1">
                <span className={LABEL_CLASS}>Email</span>
              </label>
              <input
                type="email"
                placeholder="you@example.com"
                className={INPUT_CLASS}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="form-control">
              <label className="label pb-1">
                <span className={LABEL_CLASS}>Password</span>
              </label>
              <input
                type="password"
                placeholder="••••••••"
                className={INPUT_CLASS}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
              />
            </div>

            {!isSignUp && (
              <button
                type="button"
                onClick={handleForgotPassword}
                className="link link-hover text-xs text-base-content/60 hover:text-primary self-start"
              >
                Forgot password?
              </button>
            )}

            {error && (
              <div className="rounded-lg bg-error/10 border border-error/20 px-3 py-2.5">
                <p className="text-error text-sm">{error}</p>
              </div>
            )}
            {notice && (
              <div className="rounded-lg bg-success/10 border border-success/20 px-3 py-2.5">
                <p className="text-success text-sm">{notice}</p>
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full mt-2 shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-shadow"
              disabled={loading}
            >
              {loading ? (
                <span className="loading loading-spinner loading-sm" />
              ) : isSignUp ? (
                <>
                  <UserPlus className="w-4 h-4" />
                  Create Account
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  Sign In
                </>
              )}
            </button>
          </form>

          <div className="mt-5 pt-4 border-t border-base-content/5 text-center text-sm text-base-content/55">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              className="link link-hover font-medium text-primary hover:text-primary/80 transition-colors"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError('');
                setNotice('');
              }}
            >
              {isSignUp ? 'Sign in' : 'Sign up'}
            </button>
          </div>
        </div>
      </div>
      <LegalFooter />
    </div>
  );
}
