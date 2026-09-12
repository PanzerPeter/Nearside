import { useEffect, useState } from 'react';
import { CheckCheck, Circle, Database, EyeOff, Lock, PenLine, ShieldAlert } from 'lucide-react';
import { MIN_PASSPHRASE_LENGTH, type RelockAfter } from '../../lib/app-lock';
import type { AppLock } from '../../hooks/useAppLock';
import { ServerView } from '../ServerView';
import { SecurityLimits } from '../SecurityLimits';
import { Card, NavRow, Note, ToggleRow } from './SettingsUi';
import { applyPrivacyPrefs, privacyPrefs, setPrivacyPref } from '../../lib/privacy-prefs';
import { usePrivacyPrefs } from '../../hooks/usePrivacyPrefs';
import { fetchShareRead, setShareRead } from '../../lib/receipts';
import { useToast } from '../../hooks/useToast';
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
  const signals = usePrivacyPrefs();
  const toast = useToast();
  /** True while the read-receipt switch is waiting on the server. That one is
   *  a row in the database, not a local flag, so the switch must not pretend
   *  it moved until the write lands. */
  const [savingReceipts, setSavingReceipts] = useState(false);

  // The account's answer, not this device's cache: an account signed in on a
  // second phone brings its setting with it.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const shared = await fetchShareRead();
      if (alive) applyPrivacyPrefs({ ...privacyPrefs(), readReceipts: shared });
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function toggleReceipts() {
    const next = !signals.readReceipts;
    setSavingReceipts(true);
    try {
      await setShareRead(next);
      applyPrivacyPrefs({ ...privacyPrefs(), readReceipts: next });
    } catch {
      // Left as it was: a switch that moved while the server kept the old
      // answer is the one failure this setting cannot afford.
      toast.error(t('privacy.receiptsFailed'));
    } finally {
      setSavingReceipts(false);
    }
  }

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

  // Subpages rather than modals, so the back gesture walks out of each of them
  // the way it walks out of every other settings page. See `SettingsPage`.
  if (showHidden) return <HiddenRequests onBack={() => setShowHidden(false)} />;
  if (showLimits) return <SecurityLimits onBack={() => setShowLimits(false)} />;
  if (showServerView)
    return (
      <ServerView
        onBack={() => setShowServerView(false)}
        onOpenLimits={() => {
          setShowServerView(false);
          setShowLimits(true);
        }}
      />
    );

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
            <p className="text-meta text-strong">{t('privacy.appLockIntro')}</p>
            <input
              type="password"
              className="input input-sm w-full"
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
              className="input input-sm w-full"
              placeholder={t('privacy.passphraseAgain')}
              value={lockRepeat}
              onChange={(e) => {
                setLockRepeat(e.target.value);
                setLockError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            {lockError && <p className="text-meta text-error">{lockError}</p>}
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
            <span className="text-body">{t('privacy.lockAfter')}</span>
            <select
              className="select select-sm"
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

      {/* Three things a device says about you without anybody typing them. Each
          switch is symmetric — off stops this device sending *and* showing —
          because the alternative is watching somebody who cannot watch you. */}
      <Card title={t('privacy.signals')}>
        <ToggleRow
          icon={CheckCheck}
          label={t('privacy.readReceipts')}
          hint={t('privacy.readReceiptsHint')}
          checked={signals.readReceipts}
          busy={savingReceipts}
          onChange={() => void toggleReceipts()}
        />
        <ToggleRow
          icon={PenLine}
          label={t('privacy.typing')}
          hint={t('privacy.typingHint')}
          checked={signals.typing}
          onChange={() => setPrivacyPref('typing', !signals.typing)}
        />
        <ToggleRow
          icon={Circle}
          label={t('privacy.presence')}
          hint={t('privacy.presenceHint')}
          checked={signals.presence}
          onChange={() => setPrivacyPref('presence', !signals.presence)}
        />
      </Card>
      <Note>{t('privacy.signalsNote')}</Note>

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

    </>
  );
}
