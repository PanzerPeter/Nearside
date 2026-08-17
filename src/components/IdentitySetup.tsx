import { useEffect, useState } from 'react';
import { Eye, ShieldAlert } from 'lucide-react';
import { setScreenGuard } from '../lib/screen-guard';
import { restoreErrorMessage } from '../lib/restore-error';
import { useT } from '../hooks/useT';

interface Props {
  onCreate: () => Promise<string>;
  /** Releases the gate. The seed is already stored by the time this fires;
   *  this is the human confirming they hold a copy. */
  onConfirm: () => Promise<void>;
  onRestore: (phrase: string) => Promise<void>;
  /** Whose key this is. Keys are per account, so on a phone with more than one
   *  the screen has to say which account it is about to mint or restore a key
   *  for — restoring the wrong phrase into the wrong account is silent
   *  otherwise, and only shows up later as messages that will not open. */
  account: string;
  /** The only way off this screen without finishing. Without it, signing in as
   *  the wrong account strands the user on a phrase prompt with no exit. */
  onSignOut: () => void;
  secureStorage: boolean;
}

type Stage = 'choose' | 'show' | 'confirm' | 'restore';

export function IdentitySetup({
  onCreate,
  onConfirm,
  onRestore,
  account,
  onSignOut,
  secureStorage,
}: Props) {
  const t = useT();
  const [stage, setStage] = useState<Stage>('choose');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState(false);

  // Held for the 'show' and 'confirm' stages, not just 'show': the confirm stage
  // can send the user back for another look, and a flag toggled off in between
  // leaves a window where the recents thumbnail catches the words.
  const guarded = stage === 'show' || stage === 'confirm';
  useEffect(() => {
    void setScreenGuard(guarded, 'recovery-phrase');
    return () => {
      void setScreenGuard(false, 'recovery-phrase');
    };
  }, [guarded]);

  // Re-hide whenever the stage changes, so returning to the words from the
  // confirm step does not put them straight back on screen.
  useEffect(() => {
    setRevealed(false);
  }, [stage]);

  const words = phrase ? phrase.split(' ') : [];
  // Three words, chosen up front so the indices do not shuffle as the user types.
  const [checkIndexes] = useState(() => [2, 5, 9]);

  async function begin() {
    setPhrase(await onCreate());
    setStage('show');
  }

  async function restore() {
    try {
      await onRestore(typed);
    } catch (e) {
      setError(restoreErrorMessage(typed, e));
    }
  }

  const typedWords = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const confirmOk =
    typedWords.length === checkIndexes.length &&
    checkIndexes.every((wordIndex, slot) => typedWords[slot] === words[wordIndex]);

  async function finishConfirm() {
    // Drop the phrase from React state before releasing the gate: it has served
    // its only purpose, and the shorter it lives in memory the better.
    setPhrase('');
    setTyped('');
    await onConfirm();
  }

  return (
    <div className="h-dvh flex items-center justify-center bg-base-300 p-4 pt-[calc(1rem+var(--safe-top))] pb-[calc(1rem+var(--safe-bottom))]">
      <div className="card bg-base-100 w-full max-w-md shadow-modal">
        <div className="card-body gap-4">
          {!secureStorage && (
            <div className="alert alert-warning text-sm">{t('identity.insecureBrowser')}</div>
          )}

          <p className="text-xs text-base-content/60">
            {t('account.signedInAs')}{' '}
            <span className="font-medium text-base-content/70">{account}</span>
          </p>

          {stage === 'choose' && (
            <>
              <h1 className="card-title">{t('identity.yourKey')}</h1>
              <p className="text-sm text-base-content/70">{t('identity.yourKeyBody')}</p>
              <button className="btn btn-primary" onClick={begin}>
                {t('identity.createKey')}
              </button>
              <button className="btn btn-ghost" onClick={() => setStage('restore')}>
                {t('identity.havePhrase')}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onSignOut}>
                {t('common.signOut')}
              </button>
            </>
          )}

          {stage === 'show' && (
            <>
              <h1 className="card-title">{t('identity.writeDown', { count: 12 })}</h1>
              <p className="text-sm text-base-content/70">{t('identity.writeDownBody')}</p>

              <div className="relative">
                <ol
                  className={`grid grid-cols-2 gap-1.5 font-mono text-sm bg-base-200 rounded-box p-3 transition-[filter] ${
                    revealed ? '' : 'blur-sm select-none'
                  }`}
                  style={{ transitionDuration: 'var(--motion-enter-duration)' }}
                  aria-hidden={!revealed}
                >
                  {words.map((w, i) => (
                    <li key={i} className="tabular-nums flex gap-1.5">
                      <span className="text-base-content/40 w-5 text-right">{i + 1}.</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ol>

                {!revealed && (
                  <button
                    className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-box bg-base-100/40 text-sm font-medium"
                    onClick={() => setRevealed(true)}
                  >
                    <Eye className="w-5 h-5" />
                    {t('identity.tapToShow')}
                  </button>
                )}
              </div>

              <p className="flex items-start gap-2 text-xs text-base-content/60">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-px" />
                <span>{t('identity.onlyCopy')}</span>
              </p>

              <button
                className="btn btn-primary"
                disabled={!revealed}
                onClick={() => { setTyped(''); setStage('confirm'); }}
              >
                {t('identity.writtenDown')}
              </button>
            </>
          )}

          {stage === 'confirm' && (
            <>
              <h1 className="card-title">{t('identity.checkCopy')}</h1>
              {secureStorage && (
                <p className="text-xs text-base-content/50">{t('identity.screenshotsBlocked')}</p>
              )}
              <p className="text-sm text-base-content/70">
                {t('identity.typeWords', { words: checkIndexes.map((i) => i + 1).join(', ') })}
              </p>
              <input
                className="input input-bordered font-mono"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button
                className="btn btn-primary"
                disabled={!confirmOk}
                onClick={() => void finishConfirm()}
              >
                {t('common.done')}
              </button>
            </>
          )}

          {stage === 'restore' && (
            <>
              <h1 className="card-title">{t('identity.enterPhrase')}</h1>
              <textarea
                className="textarea textarea-bordered font-mono"
                rows={3}
                value={typed}
                onChange={(e) => { setTyped(e.target.value); setError(''); }}
                autoCapitalize="none"
                autoCorrect="off"
              />
              {error && <p className="text-error text-sm">{error}</p>}
              <button className="btn btn-primary" onClick={restore}>
                {t('identity.restore')}
              </button>
              <button className="btn btn-ghost" onClick={() => setStage('choose')}>
                {t('common.back')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
