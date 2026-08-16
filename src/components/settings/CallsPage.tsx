import { useEffect, useState } from 'react';
import { BellRing, PhoneCall, ShieldCheck } from 'lucide-react';
import { fullScreenRingAllowed, openFullScreenRingSettings } from '../../lib/call/native';
import { isRingtoneMuted, setRingtoneMuted } from '../../lib/call/ringtone';
import { isMobileNative } from '../../lib/platform';
import { ActionRow, Card, InfoRow, ToggleRow } from './SettingsUi';

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
            label="Calls will not ring"
            hint="Android is holding back full-screen notifications, so an incoming call arrives as a banner and a locked phone shows nothing."
            action="Allow"
            onAction={() => void openFullScreenRingSettings()}
          />
        )}
        {native && ringAllowed === true && (
          <InfoRow
            icon={ShieldCheck}
            label="Full-screen calls"
            hint="A call takes over the screen, and a locked phone shows who is calling."
            status="Allowed"
          />
        )}
        {native && ringAllowed === null && (
          <InfoRow icon={PhoneCall} label="Full-screen calls" hint="Checking…" />
        )}
        <ToggleRow
          icon={BellRing}
          label="Ring out loud"
          hint={
            ringMuted
              ? 'A call arriving while the app is open stays silent. The screen still shows it.'
              : 'Play a tone in the app when a call comes in. Separate from the message chime.'
          }
          checked={!ringMuted}
          onChange={() => {
            const next = !ringMuted;
            setMuted(next);
            setRingtoneMuted(next);
          }}
        />
      </Card>

      <Card title="What a call leaves behind">
        <div className="px-3 py-2.5">
          <p className="text-xs text-base-content/70 leading-relaxed">
            Nothing. Voice and video go straight between the two phones, encrypted, and the offers
            and answers that set the call up are sealed to your contact&rsquo;s key. No row records
            that a call happened, who it was with, or how long it lasted. Each phone does learn the
            other&rsquo;s IP address.
          </p>
        </div>
      </Card>
    </>
  );
}
