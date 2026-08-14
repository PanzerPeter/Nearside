// What a conversation turns out to contain: the links in it, and the days
// somebody proposed. Extraction only — nothing here is written anywhere, and
// nothing leaves the device.
//
// It reads the local mirror (`localdb.ts`), which is the only place decrypted
// bodies exist. The server dropped `messages.content` in 0023, so a panel built
// from a server query is not a thing this app can have; the consequence is the
// same one search already lives with — a conversation this device never loaded
// has nothing to extract.
//
// The matching is deliberately narrow. A panel that guesses wrong is worse than
// a panel with fewer rows: every entry here is checkable against the message it
// came from, which is why each one carries the exact phrase that produced it.

import { linkify } from './linkify';
import { formatTime } from './time';

/** A decrypted message, as the mirror holds it. */
export interface InsightSource {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
}

export interface LinkInsight {
  href: string;
  /** The link as it was typed, which is what the row shows — an `https://`
   *  glued onto a bare host is our doing, not the sender's. */
  label: string;
  /** The most recent message that carried it. */
  messageId: string;
  userId: string;
  at: string;
  count: number;
}

export interface DateInsight {
  messageId: string;
  userId: string;
  /** Exactly the text that was matched, so the row can be checked against the
   *  message rather than trusted. */
  phrase: string;
  /** Epoch milliseconds, local to this device. */
  when: number;
  /** False when only a day was named: the panel shows a date, not 00:00. */
  hasTime: boolean;
  /** When the message was sent — the anchor the phrase was resolved against. */
  at: string;
  /** The message body, for the line of context under the date. */
  text: string;
}

const OLDEST_FIRST = (a: InsightSource, b: InsightSource) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/**
 * Every link in the conversation, most recently mentioned first.
 *
 * `linkify` is the matcher rather than a second regex written here: it is the
 * one that decides what becomes an anchor in the thread, and a panel that
 * disagreed with the thread about what counts as a link would be a panel
 * offering to open something the message never linked.
 */
export function extractLinks(messages: InsightSource[]): LinkInsight[] {
  const byHref = new Map<string, LinkInsight>();

  for (const message of [...messages].sort(OLDEST_FIRST)) {
    for (const segment of linkify(message.text)) {
      if (segment.type !== 'link') continue;
      const existing = byHref.get(segment.href);
      byHref.set(segment.href, {
        href: segment.href,
        label: segment.value,
        messageId: message.id,
        userId: message.user_id,
        at: message.created_at,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }

  return [...byHref.values()].reverse();
}

// Full names only, plus the abbreviations that are not also ordinary words.
// "sun", "sat", "mon" and "mar" all appear in English sentences, and a panel
// that reads "the sun was out" as a Sunday plan is one nobody trusts again.
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const WEEKDAY_INDEX: Record<string, number> = {
  ...Object.fromEntries(WEEKDAYS.map((name, i) => [name, i])),
  tues: 2,
  weds: 3,
  thur: 4,
  thurs: 4,
};

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.flatMap((name, i) => [
    [name, i],
    [name.slice(0, 3), i],
  ])
);

const MONTH_TOKEN = MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');

const RELATIVE = /\b(today|tonight|tomorrow)\b/gi;
const WEEKDAY = new RegExp(
  `\\b(?:next\\s+)?(${[...WEEKDAYS, 'tues', 'weds', 'thurs', 'thur'].join('|')})\\b`,
  'gi'
);
const MONTH_FIRST = new RegExp(`\\b(${MONTH_TOKEN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_TOKEN})\\b`,
  'gi'
);

// Numeric forms (3/4, 03.04) are deliberately absent: they are month-first in
// one half of the world and day-first in the other, and there is nothing in a
// message to say which one the sender meant.

// A meridiem or a colon is what separates a time from a quantity. "at 7" is as
// easily a price, a seat or a house number, and those are the rows that make a
// panel noise.
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b|\b(\d{1,2}):(\d{2})\b/gi;

/** How far after a day a time may sit and still belong to it: "friday at 7pm"
 *  and "friday, 7pm" both fit, a time two clauses later does not. */
const TIME_GAP = /^[\s,–—-]*(?:at|by|from|around|@)?[\s,]*$/i;

interface DayAnchor {
  start: number;
  end: number;
  resolve: (base: Date) => Date;
  /** Set by "tonight", which names an hour without naming a clock. */
  impliedHour?: number;
}

interface TimeMatch {
  start: number;
  end: number;
  hours: number;
  minutes: number;
}

/** Blank out every link, keeping the offsets of everything else. A URL is full
 *  of things that look like dates — `/2026/03/friday-at-7pm` — and none of them
 *  are plans somebody made. */
function maskLinks(text: string): string {
  let masked = '';
  for (const segment of linkify(text)) {
    masked += segment.type === 'link' ? ' '.repeat(segment.value.length) : segment.value;
  }
  // `linkify` trims trailing punctuation off a link and returns the remainder
  // as text, so the pieces still add up; anything left is the tail of a string
  // it never scanned.
  return masked + text.slice(masked.length);
}

function startOfDay(base: Date, dayOffset: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
  return d;
}

function dayAnchors(masked: string): DayAnchor[] {
  const anchors: DayAnchor[] = [];

  for (const m of masked.matchAll(RELATIVE)) {
    const word = m[1].toLowerCase();
    anchors.push({
      start: m.index,
      end: m.index + m[0].length,
      resolve: (base) => startOfDay(base, word === 'tomorrow' ? 1 : 0),
      impliedHour: word === 'tonight' ? 20 : undefined,
    });
  }

  for (const m of masked.matchAll(WEEKDAY)) {
    const target = WEEKDAY_INDEX[m[1].toLowerCase()];
    anchors.push({
      start: m.index,
      end: m.index + m[0].length,
      resolve: (base) => {
        // Naming today's own weekday means the next one: nobody says "monday
        // works" on a Monday about the day they are already in.
        const delta = (target - base.getDay() + 7) % 7 || 7;
        return startOfDay(base, delta);
      },
    });
  }

  const named = (month: number, day: number) => (base: Date) => {
    const candidate = new Date(base.getFullYear(), month, day);
    // A month already behind us is next year's: "January 5" said in December
    // is three weeks away, not eleven months back. Plans point forward; a past
    // date somebody is reminiscing about is the cost of that assumption.
    if (candidate < startOfDay(base, 0)) candidate.setFullYear(base.getFullYear() + 1);
    return candidate;
  };

  for (const m of masked.matchAll(MONTH_FIRST)) {
    const month = MONTH_INDEX[m[1].toLowerCase().replace('.', '')];
    const day = Number(m[2]);
    if (month === undefined || day < 1 || day > 31) continue;
    anchors.push({ start: m.index, end: m.index + m[0].length, resolve: named(month, day) });
  }

  for (const m of masked.matchAll(DAY_FIRST)) {
    const month = MONTH_INDEX[m[2].toLowerCase()];
    const day = Number(m[1]);
    if (month === undefined || day < 1 || day > 31) continue;
    anchors.push({ start: m.index, end: m.index + m[0].length, resolve: named(month, day) });
  }

  return anchors.sort((a, b) => a.start - b.start);
}

function times(masked: string): TimeMatch[] {
  const found: TimeMatch[] = [];
  for (const m of masked.matchAll(TIME)) {
    if (m[1] !== undefined) {
      const meridiem = m[3].toLowerCase();
      let hours = Number(m[1]);
      if (hours < 1 || hours > 12) continue;
      if (meridiem === 'p' && hours < 12) hours += 12;
      if (meridiem === 'a' && hours === 12) hours = 0;
      const minutes = Number(m[2] ?? 0);
      if (minutes > 59) continue;
      found.push({ start: m.index, end: m.index + m[0].length, hours, minutes });
      continue;
    }
    const hours = Number(m[4]);
    const minutes = Number(m[5]);
    if (hours > 23 || minutes > 59) continue;
    found.push({ start: m.index, end: m.index + m[0].length, hours, minutes });
  }
  return found;
}

/**
 * Every day somebody named, resolved against the message that named it and
 * sorted soonest first.
 *
 * "Friday" only means a date because of when it was said, so each phrase is
 * resolved against its own `created_at` rather than against now — scrolling
 * back through a year of messages must not slide every plan in them forward.
 */
export function extractDates(messages: InsightSource[]): DateInsight[] {
  const events: DateInsight[] = [];

  for (const message of messages) {
    const base = new Date(message.created_at);
    if (Number.isNaN(base.getTime())) continue;

    const masked = maskLinks(message.text);
    const anchors = dayAnchors(masked);
    const clock = times(masked);
    const seen = new Set<number>();

    const push = (phrase: string, when: Date, hasTime: boolean) => {
      const at = when.getTime();
      if (seen.has(at)) return;
      seen.add(at);
      events.push({
        messageId: message.id,
        userId: message.user_id,
        phrase,
        when: at,
        hasTime,
        at: message.created_at,
        text: message.text,
      });
    };

    for (const anchor of anchors) {
      const paired = clock.find(
        (t) => t.start >= anchor.end && TIME_GAP.test(masked.slice(anchor.end, t.start))
      );
      const when = anchor.resolve(base);
      const hour = paired?.hours ?? anchor.impliedHour;
      if (hour !== undefined) when.setHours(hour, paired?.minutes ?? 0, 0, 0);
      push(
        message.text.slice(anchor.start, paired ? paired.end : anchor.end),
        when,
        hour !== undefined
      );
    }

    // A time with no day is about the day it was sent — "call me at 20:30" on
    // Tuesday morning is Tuesday. Only when nothing else in the message named a
    // day, or the time already belongs to one of those.
    if (anchors.length === 0 && clock.length > 0) {
      const first = clock[0];
      const when = startOfDay(base, 0);
      when.setHours(first.hours, first.minutes, 0, 0);
      push(message.text.slice(first.start, first.end), when, true);
    }
  }

  return events.sort((a, b) => a.when - b.when || (a.at < b.at ? -1 : 1));
}

/**
 * Split the events into what is still ahead and what has been and gone.
 *
 * A day with no clock on it stays in "ahead" until that day is over: "friday"
 * is the whole of Friday, and moving it into the history at one minute past
 * midnight would take a plan off the panel on the morning it matters.
 */
export function splitDates(events: DateInsight[], nowMs: number) {
  const upcoming: DateInsight[] = [];
  const past: DateInsight[] = [];

  for (const event of events) {
    const deadline = event.hasTime ? event.when : endOfDay(event.when);
    (nowMs <= deadline ? upcoming : past).push(event);
  }

  return {
    upcoming: upcoming.sort((a, b) => a.when - b.when),
    // Soonest first in both lists, which for the past means most recent —
    // reading down the panel is reading away from now in either direction.
    past: past.sort((a, b) => b.when - a.when),
  };
}

function endOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * How the panel says when. Relative near today, absolute past that: "Friday"
 * is only useful for the Friday a few days out, and a plan four months away
 * needs a date on it.
 *
 * The clock comes from `time.ts` rather than being formatted here, so a row in
 * this panel and the message it came from show the same time in the same shape.
 */
export function formatWhen(event: DateInsight, nowMs: number): string {
  const when = new Date(event.when);
  const today = new Date(nowMs);
  const days = Math.round(
    (new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86_400_000
  );

  let day: string;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Tomorrow';
  else if (days === -1) day = 'Yesterday';
  else if (days > 1 && days < 7) day = DAY_LABELS[when.getDay()];
  else day = when.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return event.hasTime ? `${day}, ${formatTime(when.toISOString())}` : day;
}
