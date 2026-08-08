import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { MIN_PASSPHRASE_LENGTH } from '../lib/app-lock';
import { BrandMark } from './BrandMark';

interface Props {
  onUnlock: (passphrase: string) => Promise<boolean>;
  /** Milliseconds the next attempt is refused for; 0 when it is allowed. */
  waitMs: number;
  /** The only route out without the passphrase. It signs out, which keeps the
   *  account and the seed and drops this device's decrypted mirror. */
  onSignOut: () => void;
}

export function AppLockScreen({ onUnlock, waitMs, onSignOut }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(waitMs);

  useEffect(() => {
    setRemaining(waitMs);
    if (waitMs === 0) return;
    const tick = window.setInterval(() => {
      setRemaining((ms) => Math.max(0, ms - 1000));
    }, 1000);
    return () => window.clearInterval(tick);
  }, [waitMs]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || remaining > 0) return;
    setBusy(true);
    try {
      const ok = await onUnlock(passphrase);
      if (ok) return;
      setWrong(true);
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-dvh flex items-center justify-center bg-base-300 p-4">
      <form onSubmit={submit} className="card bg-base-100 w-full max-w-sm shadow-xl">
        <div className="card-body gap-4 items-center text-center">
          <BrandMark size={32} />
          <Lock className="w-6 h-6 text-base-content/50" />
          <h1 className="card-title text-lg">Nearside is locked</h1>

          <input
            type="password"
            className={`input input-bordered w-full text-center ${wrong ? 'input-error' : ''}`}
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              setWrong(false);
            }}
            placeholder="Passphrase"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            disabled={busy || remaining > 0}
          />

          {wrong && remaining === 0 && (
            <p className="text-sm text-error">That is not the passphrase.</p>
          )}
          {remaining > 0 && (
            <p className="text-sm text-base-content/60">
              Too many attempts. Try again in {Math.ceil(remaining / 1000)}s.
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={busy || remaining > 0 || passphrase.length < MIN_PASSPHRASE_LENGTH}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : 'Unlock'}
          </button>

          <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
            Forgot it — sign out instead
          </button>
          <p className="text-xs text-base-content/50">
            Signing out keeps your account and your recovery phrase. It clears the messages stored
            on this phone; they come back as you reopen each conversation.
          </p>
        </div>
      </form>
    </div>
  );
}
