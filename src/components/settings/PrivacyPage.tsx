import { useState } from 'react';
import { Database, EyeOff, Lock, ShieldAlert } from 'lucide-react';
import { MIN_PASSPHRASE_LENGTH, type RelockAfter } from '../../lib/app-lock';
import type { AppLock } from '../../hooks/useAppLock';
import { ServerView } from '../ServerView';
import { SecurityLimits } from '../SecurityLimits';
import { Card, NavRow, Note, ToggleRow } from './SettingsUi';
import { HiddenRequests } from './HiddenRequests';
import { useT } from '../../hooks/useT';

interface PrivacyPageProps {
  /** The one instance owned by `App`. Calling `useAppLock` again here would
   *  build a second state machine and the gate would stop matching the toggle. */
  appLock: AppLock;
}

export function PrivacyPage({ appLock }: PrivacyPageProps) {
  const t = useT();
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
      setLockError(t('privacy.passphraseMismatch'));
      return;
    }
    try {
      await appLock.enable(lockPhrase, appLock.relock);
      setLockPhrase('');
      setLockRepeat('');
      setLockError('');
      setLockSetup(false);
    } catch (e) {
      setLockError(e instanceof Error ? e.message : t('privacy.lockFailed'));
    }
  }

  // A subpage rather than a modal, so the back gesture walks out of it the way
  // it walks out of every other settings page. See `SettingsPage`.
  if (showHidden) return <HiddenRequests onBack={() => setShowHidden(false)} />;

  return (
    <>
      <Card title={t('privacy.onThisDevice')}>
        <ToggleRow
          icon={Lock}
          label={t('privacy.appLock')}
          hint={t('privacy.appLockHint')}
          checked={lockOn}
          onChange={() => {
            if (lockOn) void appLock.disable();
            else setLockSetup(true);
          }}
        />

        {lockSetup && appLock.state === 'off' && (
          <div className="p-3 space-y-2.5 bg-base-200/60">
            <p className="text-xs text-base-content/70">{t('privacy.appLockIntro')}</p>
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              placeholder={t('privacy.passphrasePlaceholder', { count: MIN_PASSPHRASE_LENGTH })}
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
              placeholder={t('privacy.passphraseAgain')}
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
                {t('common.turnOn')}
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
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {lockOn && (
          <label className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-sm">{t('privacy.lockAfter')}</span>
            <select
              className="select select-bordered select-sm"
              value={appLock.relock}
              onChange={(e) => void appLock.setRelock(e.target.value as RelockAfter)}
            >
              <option value="immediate">{t('privacy.lockImmediate')}</option>
              <option value="1m">{t('privacy.lockOneMinute')}</option>
              <option value="5m">{t('privacy.lockFiveMinutes')}</option>
            </select>
          </label>
        )}
        <NavRow
          icon={EyeOff}
          label={t('privacy.hiddenRequests')}
          hint={t('privacy.hiddenRequestsHint')}
          onClick={() => setShowHidden(true)}
        />
      </Card>
      {/* Load-bearing, not decoration: the lock must never read as a second
          layer of encryption over the seed. */}
      <Note>{t('privacy.lockNote')}</Note>

      <Card title={t('privacy.whatLeaves')}>
        <NavRow
          icon={Database}
          label={t('privacy.serverKnows')}
          hint={t('privacy.serverKnowsHint')}
          onClick={() => setShowServerView(true)}
        />
        <NavRow
          icon={ShieldAlert}
          label={t('privacy.limits')}
          hint={t('privacy.limitsHint')}
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
