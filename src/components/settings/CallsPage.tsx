import { useEffect, useState } from 'react';
import { BellRing, PhoneCall, ShieldCheck } from 'lucide-react';
import { fullScreenRingAllowed, openFullScreenRingSettings } from '../../lib/call/native';
import { isRingtoneMuted, setRingtoneMuted } from '../../lib/call/ringtone';
import { isMobileNative } from '../../lib/platform';
import { ActionRow, Card, InfoRow, ToggleRow } from './SettingsUi';
import { useT } from '../../hooks/useT';

/**
 * Calls, which are the one part of the app where a phone-level permission
 * decides whether the feature works at all.
 *
 * The full-screen permission row is shown in both states here, unlike the
 * warning that used to live on the settings page — that one appeared only when
 * Android had withheld it, which was right for a page somebody opens for another
 * reason and wrong for the page called "Calls". Somebody who came here to find
 * out why their phone stays quiet needs to see the row that says it does not.
 */
export function CallsPage() {
  const native = isMobileNative();
  const t = useT();
  // Null until the phone has been asked. Rendering either state before the
  // answer arrives would flash a claim about ringing on every phone that opens
  // this page.
  const [ringAllowed, setRingAllowed] = useState<boolean | null>(null);
  const [ringMuted, setMuted] = useState(isRingtoneMuted());

  // Re-read on every mount rather than once per session: the user leaves for
  // Android's settings to grant it and comes straight back here, and a cached
  // "no" would still be warning them about a phone that now rings.
  useEffect(() => {
    let active = true;
    void fullScreenRingAllowed().then((ok) => {
      if (active) setRingAllowed(ok);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <Card>
        {native && ringAllowed === false && (
          <ActionRow
            icon={PhoneCall}
            tone="warning"
            label={t('calls.willNotRing')}
            hint={t('calls.willNotRingHint')}
            action={t('common.allow')}
            onAction={() => void openFullScreenRingSettings()}
          />
        )}
        {native && ringAllowed === true && (
          <InfoRow
            icon={ShieldCheck}
            label={t('calls.fullScreen')}
            hint={t('calls.fullScreenHint')}
            status={t('common.allowed')}
          />
        )}
        {native && ringAllowed === null && (
          <InfoRow icon={PhoneCall} label={t('calls.fullScreen')} hint={t('common.checking')} />
        )}
        <ToggleRow
          icon={BellRing}
          label={t('calls.ringOutLoud')}
          hint={ringMuted ? t('calls.ringOutLoudOff') : t('calls.ringOutLoudOn')}
          checked={!ringMuted}
          onChange={() => {
            const next = !ringMuted;
            setMuted(next);
            setRingtoneMuted(next);
          }}
        />
      </Card>

      <Card title={t('calls.leavesBehind')}>
        <div className="px-3 py-2.5">
          <p className="text-xs text-base-content/70 leading-relaxed">
            {t('calls.leavesBehindBody')}
          </p>
        </div>
      </Card>
    </>
  );
}
