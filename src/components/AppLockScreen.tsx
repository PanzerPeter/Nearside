import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { MIN_PASSPHRASE_LENGTH } from '../lib/app-lock';
import { BrandMark } from './BrandMark';

interface Props {
  onUnlock: (passphrase: string) => Promise<boolean>;
  /** The twelve words. On a match the lock comes off and the app opens with
   *  this device's messages intact. */
  onUnlockWithRecoveryPhrase: (phrase: string) => Promise<boolean>;
  /** Milliseconds the next attempt is refused for; 0 when it is allowed. */
  waitMs: number;
  /** Still here for the person who has neither the passphrase nor the phrase.
   *  It signs out, which keeps the account and clears this device's mirror. */
  onSignOut: () => void;
}

export function AppLockScreen({ onUnlock, onUnlockWithRecoveryPhrase, waitMs, onSignOut }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [phrase, setPhrase] = useState('');
  const [usingPhrase, setUsingPhrase] = useState(false);
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

  const blocked = busy || remaining > 0;
  const ready = usingPhrase
    ? phrase.trim().split(/\s+/).length >= 12
    : passphrase.length >= MIN_PASSPHRASE_LENGTH;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked || !ready) return;
    setBusy(true);
    try {
      const ok = usingPhrase
        ? await onUnlockWithRecoveryPhrase(phrase)
        : await onUnlock(passphrase);
      if (ok) return;
      setWrong(true);
      // Only the passphrase is cleared on a miss. Retyping twelve words
      // because one of them was misspelled is a punishment, not a safeguard.
      if (!usingPhrase) setPassphrase('');
    } finally {
      setBusy(false);
    }
  }

  function switchTo(next: boolean) {
    setUsingPhrase(next);
    setWrong(false);
    setPassphrase('');
    setPhrase('');
  }

  return (
    <div className="h-dvh flex items-center justify-center bg-base-300 p-4">
      <form onSubmit={submit} className="card bg-base-100 w-full max-w-sm shadow-xl">
        <div className="card-body gap-4 items-center text-center">
          <BrandMark size={32} />
          <Lock className="w-6 h-6 text-base-content/50" />
          <h1 className="card-title text-lg">
            {usingPhrase ? 'Enter your recovery phrase' : 'Nearside is locked'}
          </h1>

          {usingPhrase ? (
            <>
              <p className="text-sm text-base-content/60">
                The twelve words you wrote down. They open the app and turn the lock off.
              </p>
              <textarea
                className={`textarea textarea-bordered w-full h-24 text-center ${
                  wrong ? 'textarea-error' : ''
                }`}
                value={phrase}
                onChange={(e) => {
                  setPhrase(e.target.value);
                  setWrong(false);
                }}
                placeholder="twelve words, separated by spaces"
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={blocked}
              />
            </>
          ) : (
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
              disabled={blocked}
            />
          )}

          {wrong && remaining === 0 && (
            <p className="text-sm text-error">
              {usingPhrase ? 'That is not this account’s phrase.' : 'That is not the passphrase.'}
            </p>
          )}
          {remaining > 0 && (
            <p className="text-sm text-base-content/60">
              Too many attempts. Try again in {Math.ceil(remaining / 1000)}s.
            </p>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={blocked || !ready}>
            {busy ? <span className="loading loading-spinner loading-sm" /> : 'Unlock'}
          </button>

          {usingPhrase ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => switchTo(false)}>
              Back to the passphrase
            </button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => switchTo(true)}>
              Forgot it?
            </button>
          )}

          <button
            type="button"
            className="btn btn-ghost btn-xs text-base-content/50"
            onClick={onSignOut}
          >
            Sign out instead
          </button>
        </div>
      </form>
    </div>
  );
}
