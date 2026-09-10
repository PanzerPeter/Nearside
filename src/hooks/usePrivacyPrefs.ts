// The signal settings, as a component sees them.

import { useEffect, useState } from 'react';
import { privacyPrefs, subscribePrivacyPrefs, type PrivacyPrefs } from '../lib/privacy-prefs';

/** Re-renders whoever asks when a toggle moves, wherever it was moved from —
 *  the settings page and the open conversation are siblings. */
export function usePrivacyPrefs(): PrivacyPrefs {
  const [prefs, setPrefs] = useState<PrivacyPrefs>(privacyPrefs);
  useEffect(() => subscribePrivacyPrefs(() => setPrefs({ ...privacyPrefs() })), []);
  return prefs;
}
