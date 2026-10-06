// The words on a notification, in every language the app ships.
//
// OneSignal picks one entry of `headings` and `contents` by the language the
// device reports — which the app sets to its own language with
// `User.setLanguage` (src/lib/notifications.ts), so a phone set to English
// running Nearside in German gets German banners. Without an entry for that
// language OneSignal falls back to `en`, which is what every notification did
// before this file: an app with eight languages announced its messages in one.
//
// Plain TypeScript with no Deno or npm import, so the edge functions bundle it
// from `../_shared/` and vitest imports it from `src/lib/push-copy.test.ts`.
// Keep it that way: a test of the real thing beats a tested twin kept in step
// by hand.

/** The app's languages, as `src/lib/i18n.ts` lists them. */
export const PUSH_LOCALES = ['en', 'es', 'de', 'ru', 'hu', 'fr', 'pl', 'zh'] as const;
export type PushLocale = (typeof PUSH_LOCALES)[number];

/**
 * OneSignal's code for each. Chinese is the one that differs: OneSignal keys it
 * by script, and the app answers every Chinese script with its one Simplified
 * catalog, so the same text goes under both.
 */
const ONESIGNAL_CODES: Record<PushLocale, readonly string[]> = {
  en: ['en'],
  es: ['es'],
  de: ['de'],
  ru: ['ru'],
  hu: ['hu'],
  fr: ['fr'],
  pl: ['pl'],
  zh: ['zh-Hans', 'zh-Hant'],
};

/** What the app hands `User.setLanguage` for its language. */
export function oneSignalLanguage(locale: string): string {
  return ONESIGNAL_CODES[locale as PushLocale]?.[0] ?? 'en';
}

interface Lines {
  message: string;
  photo: string;
  video: string;
  voice: string;
  sticker: string;
  someone: string;
  aGroup: string;
  voiceCall: string;
  videoCall: string;
}

/**
 * Whole sentences with the name inside them, never a name glued to a
 * fragment: German and Hungarian put the verb elsewhere, and Russian and
 * Polish would have to decline a name they cannot know the gender of — so
 * they write "Photo: {name}" and keep it in the nominative. `someone` fills the
 * same slot, so it has to read as a name in every one of these sentences.
 */
const LINES: Record<PushLocale, Lines> = {
  en: {
    message: 'New message from {name}',
    photo: '{name} sent a photo',
    video: '{name} sent a video',
    voice: '{name} sent a voice message',
    sticker: '{name} sent a sticker',
    someone: 'someone',
    aGroup: 'a group',
    voiceCall: 'Incoming voice call',
    videoCall: 'Incoming video call',
  },
  es: {
    message: 'Nuevo mensaje de {name}',
    photo: '{name} envió una foto',
    video: '{name} envió un vídeo',
    voice: '{name} envió un mensaje de voz',
    sticker: '{name} envió un sticker',
    someone: 'alguien',
    aGroup: 'un grupo',
    voiceCall: 'Llamada de voz entrante',
    videoCall: 'Videollamada entrante',
  },
  de: {
    message: 'Neue Nachricht von {name}',
    photo: '{name} hat ein Foto gesendet',
    video: '{name} hat ein Video gesendet',
    voice: '{name} hat eine Sprachnachricht gesendet',
    sticker: '{name} hat einen Sticker gesendet',
    someone: 'Unbekannt',
    aGroup: 'einer Gruppe',
    voiceCall: 'Eingehender Sprachanruf',
    videoCall: 'Eingehender Videoanruf',
  },
  ru: {
    message: 'Новое сообщение: {name}',
    photo: 'Фото: {name}',
    video: 'Видео: {name}',
    voice: 'Голосовое сообщение: {name}',
    sticker: 'Стикер: {name}',
    someone: 'неизвестный отправитель',
    aGroup: 'группа',
    voiceCall: 'Входящий голосовой звонок',
    videoCall: 'Входящий видеозвонок',
  },
  hu: {
    message: 'Új üzenet tőle: {name}',
    photo: '{name} fotót küldött',
    video: '{name} videót küldött',
    voice: '{name} hangüzenetet küldött',
    sticker: '{name} matricát küldött',
    someone: 'valaki',
    aGroup: 'egy csoport',
    voiceCall: 'Bejövő hanghívás',
    videoCall: 'Bejövő videóhívás',
  },
  fr: {
    message: 'Nouveau message de {name}',
    photo: '{name} a envoyé une photo',
    video: '{name} a envoyé une vidéo',
    voice: '{name} a envoyé un message vocal',
    sticker: '{name} a envoyé un sticker',
    someone: 'quelqu’un',
    aGroup: 'un groupe',
    voiceCall: 'Appel vocal entrant',
    videoCall: 'Appel vidéo entrant',
  },
  pl: {
    message: 'Nowa wiadomość od: {name}',
    photo: 'Zdjęcie od: {name}',
    video: 'Wideo od: {name}',
    voice: 'Wiadomość głosowa od: {name}',
    sticker: 'Naklejka od: {name}',
    someone: 'ktoś',
    aGroup: 'grupa',
    voiceCall: 'Przychodzące połączenie głosowe',
    videoCall: 'Przychodzące połączenie wideo',
  },
  zh: {
    message: '来自{name}的新消息',
    photo: '{name}发来一张照片',
    video: '{name}发来一段视频',
    voice: '{name}发来一条语音消息',
    sticker: '{name}发来一个贴纸',
    someone: '某人',
    aGroup: '一个群组',
    voiceCall: '语音来电',
    videoCall: '视频来电',
  },
};

/** One string per OneSignal language code: the shape `headings` and
 *  `contents` take. */
export type Localized = Record<string, string>;

function localized(line: (lines: Lines) => string): Localized {
  const out: Localized = {};
  for (const locale of PUSH_LOCALES) {
    for (const code of ONESIGNAL_CODES[locale]) out[code] = line(LINES[locale]);
  }
  return out;
}

function fill(template: string, name: string): string {
  return template.replace('{name}', name);
}

/**
 * The line for a message, by what it carries. Content-free by construction:
 * `media_type` is a column the server does read, so naming the kind of
 * attachment is honest, and nothing here widens it beyond that. The name is the sender's
 * display name as the server holds it, or "someone" when there is none —
 * never the private nickname the receiver gave them, which is sealed on the
 * receiver's phone (0041) where no server can read it.
 */
export function messageBody(displayName: string | null, mediaType: string | null): Localized {
  return localized((lines) => {
    const name = displayName ? `@${displayName}` : lines.someone;
    switch (mediaType) {
      case 'image':
        return fill(lines.photo, name);
      case 'video':
        return fill(lines.video, name);
      case 'audio':
        return fill(lines.voice, name);
      case 'sticker':
        return fill(lines.sticker, name);
      default:
        return fill(lines.message, name);
    }
  });
}

/** A group's notification is headed by its name, or "a group" without one. */
export function groupHeading(title: string | null): Localized {
  const trimmed = title?.trim();
  return localized((lines) => trimmed || lines.aGroup);
}

/** The same heading in every language: a name, or the app's own. */
export function fixedHeading(text: string): Localized {
  return localized(() => text);
}

/** The caller, or "someone", heading a ring. */
export function callerHeading(displayName: string | null): Localized {
  return localized((lines) => (displayName ? `@${displayName}` : lines.someone));
}

export function callBody(video: boolean): Localized {
  return localized((lines) => (video ? lines.videoCall : lines.voiceCall));
}
