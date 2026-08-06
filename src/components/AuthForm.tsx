import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { LegalFooter } from './LegalFooter';
import { BrandMark } from './BrandMark';
import { LogIn, UserPlus } from 'lucide-react';

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

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
  const [username, setUsername] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');

    if (isSignUp) {
      const normalized = username.trim().toLowerCase();
      if (!USERNAME_RE.test(normalized)) {
        setError('Username must be 3–24 characters: letters, numbers, or underscores.');
        return;
      }
      setLoading(true);
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { username: normalized, invite_code: inviteCode.trim() } },
      });
      setLoading(false);

      if (signUpError) {
        // GoTrue generally does not propagate a signup-trigger's Postgres
        // error text to the client — it collapses trigger failures to a
        // generic "Database error saving new user" and logs the real cause
        // server-side. The invite_required/invite_invalid checks below may
        // still match on some GoTrue versions, so they cost nothing to
        // keep, but the fallback can't claim to know the cause: it covers
        // both an invalid invite code and a genuine duplicate.
        const raw = signUpError.message;
        setError(
          /invite_required/.test(raw)
            ? 'An invite code is required to create an account.'
            : /invite_invalid/.test(raw)
              ? 'That invite code is not valid, or has already been used.'
              : /duplicate|already|unique|database error/i.test(raw)
                ? "Couldn't create the account. Check your invite code, or try a different username or email."
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
      redirectTo: window.location.origin,
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
              <>
                <div className="form-control">
                  <label className="label pb-1">
                    <span className={LABEL_CLASS}>Invite code</span>
                  </label>
                  <input
                    type="text"
                    placeholder="Invite code"
                    className={INPUT_CLASS}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required={isSignUp}
                    autoComplete="off"
                  />
                  <p className="text-xs text-base-content/55 mt-1">
                    Ask the person who runs this Nearside for a code.
                  </p>
                </div>

                <div className="form-control">
                  <label className="label pb-1">
                    <span className={LABEL_CLASS}>Username</span>
                  </label>
                  <input
                    type="text"
                    placeholder="johndoe"
                    className={INPUT_CLASS}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required={isSignUp}
                    minLength={3}
                    maxLength={24}
                    pattern="[a-zA-Z0-9_]+"
                    title="Letters, numbers, and underscores only"
                    autoComplete="username"
                  />
                </div>
              </>
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
