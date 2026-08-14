import { describe, expect, it } from 'vitest';
import {
  extractDates,
  extractLinks,
  formatWhen,
  splitDates,
  type InsightSource,
} from './extract';
import { formatTime } from './time';

/** Local time, deliberately: a phrase like "tomorrow at 7pm" means seven in the
 *  evening where the person typing it is, so every expectation here is built
 *  the same way the resolver builds its answer. Tests that hard-coded UTC would
 *  pass only on a machine in London. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

const parts = (ms: number) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

const msg = (text: string, created_at: string, over: Partial<InsightSource> = {}): InsightSource => ({
  id: over.id ?? `m-${created_at}-${text.slice(0, 8)}`,
  user_id: over.user_id ?? 'me',
  text,
  created_at,
});

describe('extractLinks', () => {
  it('pulls a url out of a message body', () => {
    const links = extractLinks([msg('read this https://example.com/post', at(2026, 3, 2))]);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe('https://example.com/post');
  });

  it('gives a bare www host the https scheme, as the renderer does', () => {
    const links = extractLinks([msg('www.example.com is fine', at(2026, 3, 2))]);
    expect(links[0].href).toBe('https://www.example.com');
    expect(links[0].label).toBe('www.example.com');
  });

  it('collapses a link mentioned twice into one row carrying the newest mention', () => {
    const links = extractLinks([
      msg('https://example.com', at(2026, 3, 1), { id: 'old' }),
      msg('again https://example.com', at(2026, 3, 5), { id: 'new' }),
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].count).toBe(2);
    expect(links[0].messageId).toBe('new');
  });

  it('orders newest first', () => {
    const links = extractLinks([
      msg('https://one.example', at(2026, 3, 1)),
      msg('https://two.example', at(2026, 3, 4)),
    ]);
    expect(links.map((l) => l.href)).toEqual(['https://two.example', 'https://one.example']);
  });

  it('returns nothing for a conversation with no links', () => {
    expect(extractLinks([msg('no links here', at(2026, 3, 2))])).toEqual([]);
  });
});

describe('extractDates', () => {
  it('resolves "tomorrow" against the message that said it', () => {
    const [event] = extractDates([msg('lunch tomorrow?', at(2026, 3, 2, 10))]);
    expect(parts(event.when).slice(0, 3)).toEqual([2026, 3, 3]);
    expect(event.hasTime).toBe(false);
  });

  it('resolves a time alongside the day', () => {
    const [event] = extractDates([msg('tomorrow at 7pm then', at(2026, 3, 2, 10))]);
    expect(parts(event.when)).toEqual([2026, 3, 3, 19, 0]);
    expect(event.hasTime).toBe(true);
  });

  it('takes the next occurrence of a weekday', () => {
    // 2026-03-02 is a Monday.
    const [event] = extractDates([msg('see you friday', at(2026, 3, 2, 10))]);
    expect(parts(event.when).slice(0, 3)).toEqual([2026, 3, 6]);
  });

  it('reads a weekday naming the message own day as the week after', () => {
    const [event] = extractDates([msg('monday works', at(2026, 3, 2, 10))]);
    expect(parts(event.when).slice(0, 3)).toEqual([2026, 3, 9]);
  });

  it('treats "tonight" as this evening', () => {
    const [event] = extractDates([msg('tonight?', at(2026, 3, 2, 10))]);
    expect(parts(event.when)).toEqual([2026, 3, 2, 20, 0]);
    expect(event.hasTime).toBe(true);
  });

  it('puts a bare time on the day the message was sent', () => {
    const [event] = extractDates([msg('call me at 20:30', at(2026, 3, 2, 10))]);
    expect(parts(event.when)).toEqual([2026, 3, 2, 20, 30]);
  });

  it('ignores a number with no meridiem and no colon', () => {
    // "at 7" is as likely to be a price, a seat or a street number, and a panel
    // full of those is a panel nobody opens twice.
    expect(extractDates([msg('table at 7', at(2026, 3, 2, 10))])).toEqual([]);
  });

  it('resolves a named month and day', () => {
    const [event] = extractDates([msg('the 14th of March, then', at(2026, 3, 2, 10))]);
    expect(parts(event.when).slice(0, 3)).toEqual([2026, 3, 14]);
  });

  it('rolls a month already past into next year', () => {
    const [event] = extractDates([msg('January 5 works', at(2026, 12, 20, 10))]);
    expect(parts(event.when).slice(0, 3)).toEqual([2027, 1, 5]);
  });

  it('does not read a date out of a url', () => {
    expect(
      extractDates([msg('https://example.com/friday-at-7pm/march-3', at(2026, 3, 2, 10))])
    ).toEqual([]);
  });

  it('keeps the phrase it matched, so the row is checkable against the message', () => {
    const [event] = extractDates([msg('lets meet Friday at 6:15pm', at(2026, 3, 2, 10))]);
    expect(event.phrase.toLowerCase()).toBe('friday at 6:15pm');
  });

  it('finds both days when one message names two', () => {
    const events = extractDates([msg('tuesday or wednesday', at(2026, 3, 2, 10))]);
    expect(events.map((e) => parts(e.when).slice(0, 3))).toEqual([
      [2026, 3, 3],
      [2026, 3, 4],
    ]);
  });

  it('orders events chronologically across messages', () => {
    const events = extractDates([
      msg('friday', at(2026, 3, 2, 10), { id: 'a' }),
      msg('tomorrow', at(2026, 3, 2, 11), { id: 'b' }),
    ]);
    expect(events.map((e) => e.messageId)).toEqual(['b', 'a']);
  });
});

describe('splitDates', () => {
  const events = (texts: [string, string][]) =>
    extractDates(texts.map(([text, created], i) => msg(text, created, { id: `m${i}` })));

  it('separates what is still ahead from what has passed', () => {
    const now = new Date(2026, 2, 4, 12).getTime();
    const list = events([
      ['friday', at(2026, 3, 2, 10)],
      ['tomorrow', at(2026, 3, 2, 10)],
    ]);
    const { upcoming, past } = splitDates(list, now);
    expect(upcoming.map((e) => e.phrase.toLowerCase())).toEqual(['friday']);
    expect(past.map((e) => e.phrase.toLowerCase())).toEqual(['tomorrow']);
  });

  it('keeps a day-only event listed until the day itself is over', () => {
    // A date with no clock is the whole day: at nine in the evening "friday"
    // has not passed, and dropping it into the history that morning would take
    // the plan off the panel on the very day it matters.
    const list = events([['friday', at(2026, 3, 2, 10)]]);
    const { upcoming } = splitDates(list, new Date(2026, 2, 6, 21).getTime());
    expect(upcoming).toHaveLength(1);
  });

  it('lists the most recent past event first', () => {
    const list = events([
      ['march 3', at(2026, 3, 1, 10)],
      ['march 5', at(2026, 3, 1, 10)],
    ]);
    const { past } = splitDates(list, new Date(2026, 2, 10, 12).getTime());
    expect(past.map((e) => e.phrase.toLowerCase())).toEqual(['march 5', 'march 3']);
  });
});

describe('formatWhen', () => {
  const one = (text: string, created: string) => extractDates([msg(text, created)])[0];
  // The clock comes from `time.ts`, so the panel reads the same way the thread
  // does — including in a locale that writes it differently.
  const clock = (event: { when: number }) => formatTime(new Date(event.when).toISOString());

  it('says Today for the day it is', () => {
    const event = one('tonight', at(2026, 3, 2, 10));
    expect(formatWhen(event, new Date(2026, 2, 2, 9).getTime())).toBe(`Today, ${clock(event)}`);
  });

  it('says Tomorrow for the day after', () => {
    const event = one('tomorrow', at(2026, 3, 2, 10));
    expect(formatWhen(event, new Date(2026, 2, 2, 9).getTime())).toBe('Tomorrow');
  });

  it('names the weekday within the coming week', () => {
    const event = one('friday at 7pm', at(2026, 3, 2, 10));
    expect(formatWhen(event, new Date(2026, 2, 2, 9).getTime())).toBe(`Friday, ${clock(event)}`);
  });

  it('falls back to a calendar date further out', () => {
    const event = one('April 20', at(2026, 3, 2, 10));
    expect(formatWhen(event, new Date(2026, 2, 2, 9).getTime())).toMatch(/Apr/);
  });
});
