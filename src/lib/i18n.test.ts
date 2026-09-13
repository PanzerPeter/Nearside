import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { es } from '../locales/es';
import { de } from '../locales/de';
import { ru } from '../locales/ru';
import { hu } from '../locales/hu';
import { fr } from '../locales/fr';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';
import {
  LOCALES,
  deviceLocale,
  interpolate,
  resolveLocale,
  setLocaleForTest,
  t,
  type Catalog,
  type Locale,
} from './i18n';

const CATALOGS: Record<Locale, Catalog> = { en, es, de, ru, hu, fr, pl, zh };

const TRANSLATED = (Object.keys(CATALOGS) as Locale[]).filter((code) => code !== 'en');

describe('catalogs', () => {
  // The type system already requires every key; this catches the half of the
  // problem it cannot see — a line copied across and left in English.
  it('answers every key in every language', () => {
    for (const code of LOCALES) {
      const missing = Object.keys(en).filter((key) => !(key in CATALOGS[code]));
      expect(missing, `${code} is missing keys`).toEqual([]);
    }
  });

  it('has no key that only one language knows about', () => {
    for (const code of LOCALES) {
      const extra = Object.keys(CATALOGS[code]).filter((key) => !(key in en));
      expect(extra, `${code} has keys English does not`).toEqual([]);
    }
  });

  it('keeps every placeholder a translation was handed', () => {
    const names = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const code of TRANSLATED) {
      for (const [key, value] of Object.entries(en)) {
        expect(names(CATALOGS[code][key as keyof typeof en]), `${code} · ${key}`).toEqual(
          names(value)
        );
      }
    }
  });

  it('leaves nothing untranslated', () => {
    // A string identical to the English one is nearly always a line somebody
    // forgot rather than a word that happens to be the same. The exceptions are
    // listed, so adding one is a decision rather than an oversight.
    const SAME_IN_SOME_LANGUAGE = new Set([
      'appearance.themes',
      'themes.packs',
      'themes.preview',
      'themes.sampleOnline',
      'privacy.lockOneMinute',
      'privacy.lockFiveMinutes',
      'settings.language',
      'language.title',
      // Byte units. Spanish and German write them the way English does; only
      // Russian has its own.
      'units.b',
      'units.kb',
      'units.mb',
      'units.gb',
      // "Offline" is the German word for it too.
      'presence.offline',
      // "Emoji" and "Video" are the same word wherever they appear here.
      'composer.emoji',
      'composer.video',
      // A full stop, which every one of these languages ends the sentence with
      // except German, where the separable verb lands after the last name.
      'auth.agreeSuffix',
      // Loanwords Spanish keeps as they are.
      'tabs.chats',
      'stickers.one',
      'preview.sticker',
      'preview.video',
      'panel.links',
      'voice.pause',
      // German borrows "Passphrase" whole.
      'lock.passphrase',
      // "Normal" is the same word in Spanish and in German.
      'alerts.default',
      // French and English share more vocabulary than any other pair here, and
      // each of these is the ordinary French word rather than a line nobody
      // translated: minutes, notifications, photos, dates, messages and
      // conversations are spelled the same in both.
      'time.minutes#one',
      'time.minutes#few',
      'time.minutes#many',
      'time.minutes#other',
      'alerts.title',
      'alerts.urgent',
      'composer.image',
      'preview.photo',
      'chatList.direct',
      'panel.dates',
      'settings.notifications',
      'themes.sampleComposer',
      'storage.messages#one',
      'storage.messages#few',
      'storage.messages#many',
      'storage.messages#other',
      'storage.conversations#one',
      'storage.conversations#few',
      'storage.conversations#many',
      'storage.conversations#other',
      'media.nounPhoto',
      'transcript.messages#one',
      'transcript.messages#few',
      'transcript.messages#many',
      'transcript.messages#other',
    ]);
    for (const code of TRANSLATED) {
      const untranslated = Object.keys(en).filter(
        (key) =>
          !SAME_IN_SOME_LANGUAGE.has(key) &&
          CATALOGS[code][key as keyof typeof en] === en[key as keyof typeof en]
      );
      expect(untranslated, `${code} still reads English here`).toEqual([]);
    }
  });
});

describe('t', () => {
  it('returns the string for the language in force', () => {
    setLocaleForTest('de');
    expect(t('common.cancel')).toBe('Abbrechen');
    setLocaleForTest('ru');
    expect(t('common.cancel')).toBe('Отмена');
    setLocaleForTest('en');
  });

  it('substitutes placeholders', () => {
    setLocaleForTest('en');
    expect(t('themes.previewOpen', { name: 'Dusk' })).toBe('Preview Dusk');
  });

  it('picks the Russian plural by category, not by "is it one"', () => {
    setLocaleForTest('ru');
    expect(t('storage.messages', { count: 1 })).toBe('1 сообщение');
    expect(t('storage.messages', { count: 3 })).toBe('3 сообщения');
    expect(t('storage.messages', { count: 7 })).toBe('7 сообщений');
    // 21 is `one` in Russian and would read as "21 сообщений" under an
    // English-shaped one/other rule.
    expect(t('storage.messages', { count: 21 })).toBe('21 сообщение');
    setLocaleForTest('en');
  });

  it('picks the English plural', () => {
    setLocaleForTest('en');
    expect(t('storage.files', { count: 1 })).toBe('1 file');
    expect(t('storage.files', { count: 4 })).toBe('4 files');
  });
});

describe('interpolate', () => {
  it('leaves a placeholder it was given no value for', () => {
    // Visible in the sentence rather than silently blank, so a translation that
    // dropped a variable is reported by the screen it is on.
    expect(interpolate('Hello {name}', {})).toBe('Hello {name}');
  });
});

describe('locale resolution', () => {
  it('matches on the base subtag', () => {
    expect(deviceLocale(['es-419'])).toBe('es');
    expect(deviceLocale(['de-AT', 'en-GB'])).toBe('de');
    expect(deviceLocale(['ru-RU'])).toBe('ru');
  });

  it('falls back to English for a language that does not ship', () => {
    expect(deviceLocale(['it-IT', 'nl'])).toBe('en');
    expect(deviceLocale([])).toBe('en');
  });

  it('answers every Chinese script with the one catalog that ships', () => {
    // Simplified is what `zh.ts` holds, so a Traditional phone gets it rather
    // than falling through to English.
    expect(deviceLocale(['zh-Hans-CN'])).toBe('zh');
    expect(deviceLocale(['zh-TW'])).toBe('zh');
  });

  it('takes an explicit choice over the device', () => {
    expect(resolveLocale('de')).toBe('de');
  });
});
