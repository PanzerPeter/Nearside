import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { KeyRound } from 'lucide-react';
import { useT } from '../hooks/useT';

interface SetNewPasswordProps {
  onDone: () => void;
}

export function SetNewPassword({ onDone }: SetNewPasswordProps) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 6) {
      setError(t('auth.passwordTooShort', { count: 6 }));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.passwordsDiffer'));
      return;
    }
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) setError(updateError.message);
    else onDone();
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-base-300 px-4 py-safe">
      <div className="card w-full max-w-sm bg-base-100 shadow-modal border border-base-content/5">
        <div className="card-body p-6 sm:p-8">
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <KeyRound className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold tracking-tight">{t('auth.setNewPassword')}</h1>
          </div>
          <p className="text-center text-base-content/60 text-sm mb-6">
            {t('auth.chooseNewPassword')}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="password"
              placeholder={t('auth.newPassword')}
              className="input w-full bg-base-200/50 border border-base-content/10 focus:border-primary"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
            <input
              type="password"
              placeholder={t('auth.confirmNewPassword')}
              className="input w-full bg-base-200/50 border border-base-content/10 focus:border-primary"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />

            {error && (
              <div className="rounded-lg bg-error/10 border border-error/20 px-3 py-2.5">
                <p className="text-error text-sm">{error}</p>
              </div>
            )}

            <button type="submit" className="btn btn-primary w-full" disabled={loading}>
              {loading ? (
                <span className="loading loading-spinner loading-sm" />
              ) : (
                t('auth.updatePassword')
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
