import { useState } from 'react';
import { Database, EyeOff, Lock, ShieldAlert } from 'lucide-react';
import { MIN_PASSPHRASE_LENGTH, type RelockAfter } from '../../lib/app-lock';
import type { AppLock } from '../../hooks/useAppLock';
import { ServerView } from '../ServerView';
import { SecurityLimits } from '../SecurityLimits';
import { Card, NavRow, Note, ToggleRow } from './SettingsUi';
import { HiddenRequests } from './HiddenRequests';

interface PrivacyPageProps {
  /** The one instance owned by `App`. Calling `useAppLock` again here would
   *  build a second state machine and the gate would stop matching the toggle. */
  appLock: AppLock;
}

export function PrivacyPage({ appLock }: PrivacyPageProps) {
  const [lockSetup, setLockSetup] = useState(false);
  const [lockPhrase, setLockPhrase] = useState('');
  const [lockRepeat, setLockRepeat] = useState('');
  const [lockError, setLockError] = useState('');

  const [showServerView, setShowServerView] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const lockOn = appLock.state !== 'off' && appLock.state !== 'loading';

  async function saveAppLock() {
    if (lockPhrase !== lockRepeat) {
      setLockError('Those do not match.');
      return;
    }
    try {
      await appLock.enable(lockPhrase, appLock.relock);
      setLockPhrase('');
      setLockRepeat('');
      setLockError('');
      setLockSetup(false);
    } catch (e) {
      setLockError(e instanceof Error ? e.message : 'Could not set the lock.');
    }
  }

  // A subpage rather than a modal, so the back gesture walks out of it the way
  // it walks out of every other settings page. See `SettingsPage`.
  if (showHidden) return <HiddenRequests onBack={() => setShowHidden(false)} />;

  return (
    <>
      <Card title="On this device">
        <ToggleRow
          icon={Lock}
          label="App lock"
          hint="Ask for a passphrase before opening Nearside"
          checked={lockOn}
          onChange={() => {
            if (lockOn) void appLock.disable();
            else setLockSetup(true);
          }}
        />

        {lockSetup && appLock.state === 'off' && (
          <div className="p-3 space-y-2.5 bg-base-200/60">
            <p className="text-xs text-base-content/70">
              Stops someone picking up an unlocked phone and reading your conversations. Forget it
              and your recovery phrase opens the app instead.
            </p>
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              placeholder={`Passphrase, at least ${MIN_PASSPHRASE_LENGTH} characters`}
              value={lockPhrase}
              onChange={(e) => {
                setLockPhrase(e.target.value);
                setLockError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              placeholder="Again"
              value={lockRepeat}
              onChange={(e) => {
                setLockRepeat(e.target.value);
                setLockError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            {lockError && <p className="text-xs text-error">{lockError}</p>}
            <div className="flex gap-2">
              <button
                className="btn btn-primary btn-sm flex-1"
                disabled={lockPhrase.length < MIN_PASSPHRASE_LENGTH}
                onClick={() => void saveAppLock()}
              >
                Turn on
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setLockSetup(false);
                  setLockPhrase('');
                  setLockRepeat('');
                  setLockError('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {lockOn && (
          <label className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-sm">Lock after</span>
            <select
              className="select select-bordered select-sm"
              value={appLock.relock}
              onChange={(e) => void appLock.setRelock(e.target.value as RelockAfter)}
            >
              <option value="immediate">Leaving the app</option>
              <option value="1m">1 minute</option>
              <option value="5m">5 minutes</option>
            </select>
          </label>
        )}
        <NavRow
          icon={EyeOff}
          label="Hidden requests"
          hint="People whose requests this device does not show"
          onClick={() => setShowHidden(true)}
        />
      </Card>
      {/* Load-bearing, not decoration: the lock must never read as a second
          layer of encryption over the seed. */}
      <Note>
        This guards the app, not your key. The key already sits in the phone&rsquo;s keystore and
        nothing here re-encrypts it.
      </Note>

      <Card title="What leaves this device">
        <NavRow
          icon={Database}
          label="What the server knows"
          hint="Live counts, straight from the database"
          onClick={() => setShowServerView(true)}
        />
        <NavRow
          icon={ShieldAlert}
          label="Where this protection stops"
          hint="The parts encryption cannot fix"
          onClick={() => setShowLimits(true)}
        />
      </Card>

      {showServerView && (
        <ServerView
          onClose={() => setShowServerView(false)}
          onOpenLimits={() => {
            setShowServerView(false);
            setShowLimits(true);
          }}
        />
      )}
      {showLimits && <SecurityLimits onClose={() => setShowLimits(false)} />}
    </>
  );
}
