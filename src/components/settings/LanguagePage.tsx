import { Check, Languages } from 'lucide-react';
import {
  LOCALES,
  LOCALE_NAMES,
  deviceLocale,
  localePreference,
  setLocalePreference,
  type LocalePreference,
} from '../../lib/i18n';
import { useLocale, useT } from '../../hooks/useT';
import { Card, Note } from './SettingsUi';

/**
 * The language the app speaks.
 *
 * Each language is written in itself — a list of languages translated into the
 * one you cannot read is a list you cannot use, and somebody who opened this
 * page because the app is in a language they do not want needs to recognise
 * their own without reading anything else on the screen.
 *
 * `useLocale()` rather than local state: the choice is stored in a module and
 * `setLocalePreference` repaints the whole app, so the tick has to follow the
 * language actually in force rather than a copy of it made at mount.
 */
export function LanguagePage() {
  const t = useT();
  const active = useLocale();
  // Read per render, not once at mount: `system` and the language it currently
  // resolves to are two different rows, and the tick belongs on the one the
  // user chose.
  const preference = localePreference();

  function choose(next: LocalePreference) {
    setLocalePreference(next);
  }

  return (
    <>
      <Card>
        <Row
          label={t('language.system')}
          hint={`${t('language.systemHint')} ${LOCALE_NAMES[deviceLocale()]}`}
          selected={preference === 'system'}
          onSelect={() => choose('system')}
        />
      </Card>

      <Card>
        {LOCALES.map((code) => (
          <Row
            key={code}
            label={LOCALE_NAMES[code]}
            // The language the app would be in if this row were tapped, so the
            // row means the same thing whichever language is on screen now.
            lang={code}
            selected={preference === code}
            // A tick on the row the app is speaking, even when that came from
            // the device rather than from a choice here: without it "Match my
            // device" is the only marked row and the list looks inert.
            inUse={preference === 'system' && active === code}
            inUseLabel={t('themes.inUse')}
            onSelect={() => choose(code)}
          />
        ))}
      </Card>

      <Note>{t('language.note')}</Note>
      <Note>{t('language.untranslated')}</Note>
    </>
  );
}

function Row({
  label,
  hint,
  lang,
  selected,
  inUse,
  inUseLabel,
  onSelect,
}: {
  label: string;
  hint?: string;
  lang?: string;
  selected: boolean;
  inUse?: boolean;
  inUseLabel?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="w-full text-left hover:bg-base-content/5"
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="flex items-center gap-2.5 min-w-0">
          <Languages
            className={`w-4 h-4 shrink-0 ${selected ? 'text-primary' : 'text-base-content/60'}`}
          />
          <span className="min-w-0">
            {/* `lang` on the name itself: the WebView picks a font and a
                screen reader picks a voice from it, and a Cyrillic name
                announced by an English voice is unusable to the person most
                likely to need this row. */}
            <span className="block text-sm font-medium truncate" lang={lang}>
              {label}
            </span>
            {hint && <span className="block text-xs text-base-content/60">{hint}</span>}
            {inUse && inUseLabel && (
              <span className="block text-xs text-base-content/50">{inUseLabel}</span>
            )}
          </span>
        </span>
        {selected && <Check className="w-4 h-4 text-primary shrink-0" />}
      </span>
    </button>
  );
}
