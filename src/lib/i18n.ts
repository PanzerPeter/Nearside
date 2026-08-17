// The app's language, and the one place a string turns into words.
//
// Module-level rather than a React context, for the same reason the theme and
// the motion preference are: half the strings the app shows are produced
// outside a component — `time.ts` labelling a date divider, `media-errors.ts`
// explaining why an attachment will not send, `disappearing.ts` writing the
// timer line into a thread. Threading a `t` through those would mean handing
// every lib function a translator it has no other reason to know about.
// Components subscribe through `useT()` (`hooks/useT.ts`), which is what makes
// a language change repaint the screen.
//
// Catalogs are typed against the English one, so a key added there without a
// Spanish, German or Russian line fails `npm run typecheck` rather than
// reaching a phone and rendering as a dotted identifier.

import { en } from '../locales/en';
import { es } from '../locales/es';
import { de } from '../locales/de';
import { ru } from '../locales/ru';

/** The languages that ship. Order is the order the settings list shows. */
export const LOCALES = ['en', 'es', 'de', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

/** What the user chose. `system` follows the phone and is the default — an
 *  install on a Spanish phone should not open in English and wait to be told. */
export type LocalePreference = Locale | 'system';

/** Every line a catalog carries, defined by the English one. */
export type CatalogKey = keyof typeof en;

/** A catalog must answer every key. There is no partial translation: a missing
 *  line would fall through to English mid-sentence, which reads as a bug. */
export type Catalog = Record<CatalogKey, string>;

/** `storage.files` from `storage.files#one`. A pluralized string is stored as
 *  one line per category and asked for by the name they share. */
type PluralBase<K> = K extends `${infer Base}#${string}` ? Base : never;

/** What `t()` accepts: a plain key, or the base name of a pluralized one. */
export type MessageKey = CatalogKey | PluralBase<CatalogKey>;

const CATALOGS: Record<Locale, Catalog> = { en, es, de, ru };

/** The name of each language, written in that language. A list of languages
 *  translated into the one you cannot read is a list you cannot use. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  ru: 'Русский',
};

const STORAGE_KEY = 'nearside.locale';

const DEFAULT_LOCALE: Locale = 'en';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * The stored preference, `system` when nothing was ever chosen or storage is
 * unreadable.
 *
 * Device-wide, not per account: the language is a property of the person
 * holding the phone, and a roster of accounts each remembering its own would
 * mean the sign-in screen — which belongs to no account — has no language.
 */
export function localePreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'system' || isLocale(stored)) return stored;
  } catch {
    /* private mode, or a WebView with storage disabled */
  }
  return 'system';
}

/**
 * The best shipped match for what the device asks for.
 *
 * Matched on the base subtag only: `es-419`, `es-MX` and `es-ES` are all
 * answered by the Spanish catalog. Shipping a Latin American Spanish that
 * differs from a European one is a decision for a translator, not for a
 * language tag.
 */
export function deviceLocale(tags: readonly string[] = navigatorLanguages()): Locale {
  for (const tag of tags) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
}

/** The preference resolved to a language that actually has a catalog. */
export function resolveLocale(preference: LocalePreference): Locale {
  return preference === 'system' ? deviceLocale() : preference;
}

let current: Locale = DEFAULT_LOCALE;

const listeners = new Set<() => void>();

/** The language in force. */
export function locale(): Locale {
  return current;
}

/**
 * The BCP-47 tag to hand `Intl` and `toLocale*String`.
 *
 * Always the app's language, never the device's, and never `[]` — an app set
 * to German on an English phone would otherwise print German words beside a
 * date the OS formatted its own way, which looks like a half-finished
 * translation because it is one.
 */
export function localeTag(): string {
  return current;
}

/** Subscribe to language changes. Returns the unsubscribe. */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Switch language and persist the choice.
 *
 * Takes effect on the spot: every component that reads a string does so
 * through `useT()`, so there is nothing to remount and no reload to sit
 * through. `<html lang>` moves with it, which is what the WebView hyphenates
 * and what a screen reader picks a voice from.
 */
export function setLocalePreference(preference: LocalePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* the change still applies for this session */
  }
  current = resolveLocale(preference);
  applyLocale();
  for (const listener of listeners) listener();
}

function applyLocale(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
}

/**
 * Call once, before the first render, so the opening frame is already in the
 * right language rather than flashing English and correcting itself.
 */
export function initLocale(): void {
  current = resolveLocale(localePreference());
  applyLocale();
}

/** Values substituted into `{placeholders}`. `count` also picks the plural. */
export type Vars = Record<string, string | number>;

/**
 * Pluralized keys carry their category after a `#`: `key#one`, `key#few`,
 * `key#many`, `key#other`. All four exist in every catalog, English included,
 * because the key sets have to match for the type to check them — Russian
 * needs `few` and `many`, and an English catalog missing them could not be
 * compared against it.
 */
function pluralKey(key: string, count: number, tag: string): string {
  let category: Intl.LDMLPluralRule = 'other';
  try {
    category = new Intl.PluralRules(tag).select(count);
  } catch {
    /* an environment without PluralRules gets the `other` form */
  }
  return `${key}#${category}`;
}

function lookup(catalog: Catalog, key: string): string | undefined {
  return (catalog as Record<string, string | undefined>)[key];
}

/**
 * A string, in the language in force.
 *
 * Falls back to English and then to the key itself. Neither should ever happen
 * — the catalogs are type-checked against each other — but a screen with one
 * English line on it is worth more than a screen that threw.
 */
export function t(key: MessageKey, vars?: Vars): string {
  const catalog = CATALOGS[current];
  const plural = typeof vars?.count === 'number';
  const wanted = plural ? pluralKey(key, vars.count as number, localeTag()) : key;
  const raw = lookup(catalog, wanted) ?? lookup(en, wanted) ?? lookup(catalog, key) ?? key;
  return vars ? interpolate(raw, vars) : raw;
}

/**
 * Substitute `{name}` placeholders.
 *
 * A placeholder with no value is left standing rather than blanked: a
 * translation that dropped a `{name}` is then visible in the sentence instead
 * of quietly becoming "sent you a".
 */
export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    return typeof value === 'number' ? formatNumber(value) : value;
  });
}

/** A number in the app's language — the separators differ, and a count sitting
 *  in a translated sentence written the English way reads as untranslated. */
export function formatNumber(value: number): string {
  try {
    return new Intl.NumberFormat(localeTag()).format(value);
  } catch {
    return String(value);
  }
}

/** Test seam: set the language without touching storage or the DOM. */
export function setLocaleForTest(next: Locale): void {
  current = next;
}
