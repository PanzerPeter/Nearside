import { useState } from 'react';

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
  const [stage, setStage] = useState<Stage>('choose');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');

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
    } catch {
      setError('That phrase is not valid. Check the spelling and the order.');
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
    <div className="h-dvh flex items-center justify-center bg-base-300 p-4">
      <div className="card bg-base-100 w-full max-w-md shadow-xl">
        <div className="card-body gap-4">
          {!secureStorage && (
            <div className="alert alert-warning text-sm">
              This browser cannot store your key securely. Use the Android app for anything you
              intend to keep.
            </div>
          )}

          <p className="text-xs text-base-content/60">
            Signed in as <span className="font-medium text-base-content/70">{account}</span>
          </p>

          {stage === 'choose' && (
            <>
              <h1 className="card-title">Your key</h1>
              <p className="text-sm text-base-content/70">
                Nearside encrypts your vault and your messages on this device. The key never leaves
                it, so we cannot reset it for you. Your recovery phrase is the only way back in.
              </p>
              <p className="text-sm text-base-content/70">
                Each account has its own key. If you use more than one account on this phone, each
                one needs its own phrase.
              </p>
              <button className="btn btn-primary" onClick={begin}>Create a new key</button>
              <button className="btn btn-ghost" onClick={() => setStage('restore')}>
                I have a recovery phrase
              </button>
              <button className="btn btn-ghost btn-sm" onClick={onSignOut}>
                Sign out
              </button>
            </>
          )}

          {stage === 'show' && (
            <>
              <h1 className="card-title">Write these 12 words down</h1>
              <p className="text-sm text-base-content/70">
                On paper. Not in a screenshot, and not in another app on this phone, because both
                go missing with the phone itself.
              </p>
              <ol className="grid grid-cols-2 gap-1 font-mono text-sm bg-base-200 rounded-box p-3">
                {words.map((w, i) => (
                  <li key={i} className="tabular-nums">
                    <span className="text-base-content/40">{i + 1}.</span> {w}
                  </li>
                ))}
              </ol>
              <button className="btn btn-primary" onClick={() => { setTyped(''); setStage('confirm'); }}>
                I have written them down
              </button>
            </>
          )}

          {stage === 'confirm' && (
            <>
              <h1 className="card-title">Check your copy</h1>
              <p className="text-sm text-base-content/70">
                Type words {checkIndexes.map((i) => i + 1).join(', ')}, separated by spaces.
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
                Done
              </button>
            </>
          )}

          {stage === 'restore' && (
            <>
              <h1 className="card-title">Enter your recovery phrase</h1>
              <textarea
                className="textarea textarea-bordered font-mono"
                rows={3}
                value={typed}
                onChange={(e) => { setTyped(e.target.value); setError(''); }}
                autoCapitalize="none"
                autoCorrect="off"
              />
              {error && <p className="text-error text-sm">{error}</p>}
              <button className="btn btn-primary" onClick={restore}>Restore</button>
              <button className="btn btn-ghost" onClick={() => setStage('choose')}>Back</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
