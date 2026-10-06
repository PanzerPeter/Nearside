// The notification copy lives with the edge functions that send it, in a file
// with no Deno import, so this suite tests the real one rather than a twin.
import { describe, expect, it } from 'vitest';
import {
  PUSH_LOCALES,
  callBody,
  callerHeading,
  fixedHeading,
  groupHeading,
  messageBody,
  oneSignalLanguage,
} from '../../supabase/functions/_shared/push-copy.ts';
import { LOCALES } from './i18n';

const CODES = ['en', 'es', 'de', 'ru', 'hu', 'fr', 'pl', 'zh-Hans', 'zh-Hant'];

describe('notification copy', () => {
  it('speaks every language the app does', () => {
    // A language added to the app and not here would get English banners
    // again, which is the bug this file exists to end.
    expect([...PUSH_LOCALES].sort()).toEqual([...LOCALES].sort());
  });

  it('answers every OneSignal code, with Chinese under both scripts', () => {
    const body = messageBody('anna', null);
    expect(Object.keys(body).sort()).toEqual([...CODES].sort());
    expect(body['zh-Hant']).toBe(body['zh-Hans']);
  });

  it('names the sender inside a whole sentence in every language', () => {
    for (const text of Object.values(messageBody('anna', 'image'))) {
      expect(text).toContain('@anna');
      expect(text).not.toContain('{name}');
    }
  });

  it('says what kind of attachment it was, stickers included', () => {
    expect(messageBody('anna', null).en).toBe('New message from @anna');
    expect(messageBody('anna', 'image').en).toBe('@anna sent a photo');
    expect(messageBody('anna', 'video').en).toBe('@anna sent a video');
    expect(messageBody('anna', 'audio').en).toBe('@anna sent a voice message');
    expect(messageBody('anna', 'sticker').en).toBe('@anna sent a sticker');
    expect(messageBody('anna', 'sticker').de).toBe('@anna hat einen Sticker gesendet');
  });

  it('falls back to a word that reads as a name, not a blank', () => {
    expect(messageBody(null, null).en).toBe('New message from someone');
    expect(messageBody(null, 'image').de).toBe('Unbekannt hat ein Foto gesendet');
    expect(messageBody(null, 'image').ru).toBe('Фото: неизвестный отправитель');
  });

  it('heads a group by its name, translated only when it has none', () => {
    expect(groupHeading('Trip').fr).toBe('Trip');
    expect(groupHeading('   ').fr).toBe('un groupe');
    expect(groupHeading(null).en).toBe('a group');
  });

  it('keeps a fixed heading the same everywhere', () => {
    expect(new Set(Object.values(fixedHeading('Nearside')))).toEqual(new Set(['Nearside']));
  });

  it('words a ring', () => {
    expect(callerHeading('bo').hu).toBe('@bo');
    expect(callerHeading(null).es).toBe('alguien');
    expect(callBody(true).de).toBe('Eingehender Videoanruf');
    expect(callBody(false).en).toBe('Incoming voice call');
  });

  it('reports the app language as a code the copy is keyed by', () => {
    expect(oneSignalLanguage('de')).toBe('de');
    expect(oneSignalLanguage('zh')).toBe('zh-Hans');
    expect(oneSignalLanguage('xx')).toBe('en');
    for (const locale of LOCALES) expect(CODES).toContain(oneSignalLanguage(locale));
  });
});
