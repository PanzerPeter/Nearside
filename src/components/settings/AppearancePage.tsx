import { useState } from 'react';
import { Palette, Sparkles } from 'lucide-react';
import { isMotionReduced, prefersReducedMotion, setMotionReduced } from '../../lib/motion';
import { ThemeStore } from '../ThemeStore';
import { Card, NavRow, Note, ToggleRow } from './SettingsUi';

export function AppearancePage() {
  const [reducedMotion, setReducedMotion] = useState(isMotionReduced());
  // Read once per mount, not per render: the OS setting decides whether the
  // switch below can do anything at all, and a value that changed between two
  // renders would flip the control's disabled state under the user's finger.
  // A change to it is picked up on the next mount, and by the listener
  // `initMotionPreference` installed, which repaints the app either way.
  const [osReducedMotion] = useState(prefersReducedMotion);
  const [showThemes, setShowThemes] = useState(false);

  return (
    <>
      <Card>
        <NavRow icon={Palette} label="Themes" onClick={() => setShowThemes(true)} />
        {/* Not an on/off switch for animation — off is the fuller set, on is
            the plain one. Framed as "reduce" rather than "fancy animations"
            because that is the word people look for when they want a calmer
            app, and it matches the OS setting it defers to. */}
        <ToggleRow
          icon={Sparkles}
          label="Reduce motion"
          hint={
            osReducedMotion
              ? 'Your device already asks for reduced motion, so this stays on.'
              : reducedMotion
                ? 'Plain fades and slides.'
                : 'Messages spring in, sheets rise, a sealed message glows.'
          }
          checked={reducedMotion || osReducedMotion}
          onChange={() => {
            const next = !reducedMotion;
            setReducedMotion(next);
            // Repaints the whole app on the spot — every rule hangs off one
            // attribute on <html>, so the switch demonstrates itself.
            setMotionReduced(next);
          }}
          disabled={osReducedMotion}
        />
      </Card>
      <Note>Haptics follow this switch too.</Note>

      {showThemes && <ThemeStore onClose={() => setShowThemes(false)} />}
    </>
  );
}
