import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DISPLAY_NAME_MAX } from '../lib/profile-shape';
import { rememberPendingName } from '../lib/profile-seal';
import { authRedirectTo } from '../lib/authRedirect';
import { subscribeToAuthLinkError } from '../lib/nativeAuthLinks';
import { LegalDocModal, LegalFooter, type LegalDoc } from './LegalFooter';
import { BrandMark } from './BrandMark';
import { ArrowLeft, EyeOff, Lock, LogIn, QrCode, UserPlus, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '../lib/i18n';
import { useT } from '../hooks/useT';


// Shared field styling — one source of truth for the four inputs so the focus
// treatment (blue border + soft ring, no default outline) stays consistent.
const INPUT_CLASS =
  'input w-full h-12 bg-base-200/50 border border-hairline focus:border-primary focus:bg-base-200 focus:outline-hidden focus:ring-2 focus:ring-primary/25 transition-all';

const LABEL_CLASS =
  'text-meta font-medium text-muted';

/** The brand panel's three lines — see the comment where they render. */
const POINTS: { icon: LucideIcon; key: MessageKey }[] = [
  { icon: Lock, key: 'auth.pointSealed' },
  { icon: QrCode, key: 'auth.pointNoDirectory' },
  { icon: EyeOff, key: 'auth.pointNoAds' },
];

interface AuthFormProps {
  /**
   * Present only when this form was opened to add a *second* account, with
   * somebody still signed in behind it. Absent on the ordinary signed-out
   * route, where there is nothing to go back to and a cancel button would be a
   * dead end.
   */
  onCancel?: () => void;
}

export function AuthForm({ onCancel }: AuthFormProps = {}) {
  const t = useT();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [display_name, setUsername] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  /** Sign-up only, and reset whenever the form flips: consent belongs to the
   *  account being created, so coming back to sign up asks again rather than
   *  inheriting a tick from a form the user abandoned. */
  const [agreedToLegal, setAgreedToLegal] = useState(false);
  /** Terms or Privacy opened from the consent line — the documents have to be
   *  readable before agreeing to them, not only after. */
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);

  // An emailed link that failed fails while the user is in their mail client,
  // so the sign-in screen is where they land and the only place the reason can
  // reach them.
  useEffect(() => subscribeToAuthLinkError(setError), []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');

    if (isSignUp) {
      // Re-checked here and not only on the button's `disabled`: an account may
      // not be created without this, and a disabled attribute is a hint.
      if (!agreedToLegal) {
        setError(t('auth.mustAgree'));
        return;
      }
      // Trimmed but not lowercased: the name is shown as the person wrote it.
      const normalized = display_name.trim();
      if (!normalized || normalized.length > DISPLAY_NAME_MAX) {
        setError(t('profile.nameTooLong', { count: DISPLAY_NAME_MAX }));
        return;
      }
      setLoading(true);
      // The name stays on this device until there is an identity to seal it
      // with (0061). Sent as signup metadata it sat in the auth service in
      // plaintext for the life of the account.
      rememberPendingName(normalized);
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
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
            ? t('auth.emailTaken')
            : raw
        );
        return;
      }
      // Email confirmation on: a user exists but no active session yet.
      if (data.user && !data.session) {
        setNotice(t('auth.confirmEmail'));
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
      setError(t('auth.enterEmailFirst'));
      return;
    }
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(target, {
      redirectTo: authRedirectTo('recovery'),
    });
    setLoading(false);
    if (resetError) setError(resetError.message);
    else setNotice(t('auth.resetSent'));
  }

  return (
    <div className="min-h-dvh flex bg-base-300">
      {/* The brand side, from `md` up: what the product is, in its own words,
          beside the form rather than squeezed above it. The three lines are
          the README's claims, each of which the app enforces rather than
          describes. Absent on a phone, where the screen is the form. */}
      <aside className="hidden md:flex md:w-[44%] lg:w-1/2 flex-col justify-between gap-10 bg-base-200 border-r border-hairline px-10 lg:px-16 pt-[calc(2.5rem+var(--safe-top))] pb-[calc(2.5rem+var(--safe-bottom))]">
        <div className="flex items-center gap-3">
          <BrandMark size={36} />
          <span className="text-title font-semibold text-base-content">Nearside</span>
        </div>
        <div className="max-w-md">
          <p className="text-[2.25rem] lg:text-[2.75rem] font-semibold leading-[1.08] tracking-[-0.03em] text-base-content text-balance">
            {t('auth.tagline')}
          </p>
          <ul className="mt-10 space-y-5">
            {POINTS.map(({ icon: Icon, key }) => (
              <li key={key} className="flex items-start gap-3.5">
                <span className="flex w-9 h-9 shrink-0 items-center justify-center rounded-field bg-wash text-(--brand-lit)">
                  <Icon className="w-[18px] h-[18px]" />
                </span>
                <span className="pt-1.5 text-body text-strong">{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
        <LegalFooter className="justify-start!" />
      </aside>

      <main className="flex-1 min-w-0 flex flex-col px-6 sm:px-10 pt-[calc(1.5rem+var(--safe-top))] pb-[calc(1.5rem+var(--safe-bottom))]">
        {/* Phone: the mark and the name up top, the form low on the screen
            where a thumb reaches it. Past `md` the form simply centres. */}
        <div className="md:hidden flex items-center gap-2.5 pt-2">
          <BrandMark size={36} />
          <span className="text-title font-semibold text-base-content">Nearside</span>
        </div>

        <div className="w-full max-w-sm mx-auto mt-auto md:my-auto pt-10 md:pt-0">
          {onCancel && (
            <button
              type="button"
              className="btn btn-ghost btn-sm -ml-3 mb-4 gap-1.5 text-muted"
              onClick={onCancel}
            >
              <ArrowLeft className="w-4 h-4" />
              {t('auth.backToAccount')}
            </button>
          )}
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-base-content">
            {isSignUp ? t('auth.createYourAccount') : t('auth.welcomeBack')}
          </h1>
          <p className="md:hidden mt-1.5 text-body text-muted">{t('auth.tagline')}</p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            {isSignUp && (
              <div className="flex flex-col">
                <label className="flex select-none items-center justify-between pb-1">
                  <span className={LABEL_CLASS}>{t('profile.displayName')}</span>
                </label>
                {/* No pattern and no minimum: a display name is not a handle.
                    Spaces, capitals and accents are all fine, and two people
                    may pick the same one — that is what stops it being an
                    address. The only rule left is the length cap. */}
                <input
                  type="text"
                  placeholder={t('auth.namePlaceholder')}
                  className={INPUT_CLASS}
                  value={display_name}
                  onChange={(e) => setUsername(e.target.value)}
                  required={isSignUp}
                  maxLength={DISPLAY_NAME_MAX}
                  autoComplete="name"
                />
              </div>
            )}

            <div className="flex flex-col">
              <label className="flex select-none items-center justify-between pb-1">
                <span className={LABEL_CLASS}>{t('auth.email')}</span>
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

            <div className="flex flex-col">
              <label className="flex select-none items-center justify-between pb-1">
                <span className={LABEL_CLASS}>{t('auth.password')}</span>
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
                className="link link-hover text-meta text-muted hover:text-primary self-start"
              >
                {t('auth.forgotPassword')}
              </button>
            )}

            {isSignUp && (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm checkbox-primary mt-0.5 shrink-0"
                  checked={agreedToLegal}
                  onChange={(e) => setAgreedToLegal(e.target.checked)}
                />
                <span className="text-meta leading-relaxed text-strong">
                  {t('auth.agreePrefix')}{' '}
                  {/* type="button": a bare button inside a form submits it, so
                      reading the terms would have attempted the sign-up. */}
                  <button
                    type="button"
                    className="link link-hover text-primary"
                    onClick={() => setLegalDoc('terms')}
                  >
                    {t('about.terms')}
                  </button>{' '}
                  {t('auth.agreeJoin')}{' '}
                  <button
                    type="button"
                    className="link link-hover text-primary"
                    onClick={() => setLegalDoc('privacy')}
                  >
                    {t('about.privacyPolicy')}
                  </button>
                  {t('auth.agreeSuffix')}
                </span>
              </label>
            )}

            {error && (
              <div className="rounded-field bg-error/10 border border-error/20 px-3 py-2.5">
                <p className="text-error text-body">{error}</p>
              </div>
            )}
            {notice && (
              <div className="rounded-field bg-success/10 border border-success/20 px-3 py-2.5">
                <p className="text-success text-body">{notice}</p>
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full h-12 mt-2"
              disabled={loading || (isSignUp && !agreedToLegal)}
            >
              {loading ? (
                <span className="loading loading-spinner loading-sm" />
              ) : isSignUp ? (
                <>
                  <UserPlus className="w-4 h-4" />
                  {t('auth.createAccount')}
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4" />
                  {t('auth.signIn')}
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-body text-muted">
            {isSignUp ? t('auth.haveAccount') : t('auth.noAccount')}{' '}
            <button
              type="button"
              className="link link-hover font-medium text-primary hover:text-primary/80 transition-colors"
              onClick={() => {
                setIsSignUp(!isSignUp);
                setError('');
                setNotice('');
                setAgreedToLegal(false);
              }}
            >
              {isSignUp ? t('auth.signInShort') : t('auth.signUpShort')}
            </button>
          </p>
        </div>

        <LegalFooter className="md:hidden mt-10" />
      </main>

      {legalDoc && <LegalDocModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </div>
  );
}
