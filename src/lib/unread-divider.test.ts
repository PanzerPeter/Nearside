import { describe, expect, it } from 'vitest';
import { firstUnreadId } from './unread-divider';

const ME = 'me';

function m(id: string, from: string, at: string) {
  return { id, from, created_at: at };
}

describe('where the unread line goes', () => {
  it('marks the first message that arrived after the watermark', () => {
    const rows = [
      m('a', 'them', '2026-09-01T10:00:00Z'),
      m('b', 'them', '2026-09-01T11:00:00Z'),
      m('c', 'them', '2026-09-01T12:00:00Z'),
    ];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:30:00Z')).toBe('b');
  });

  it('never marks your own message', () => {
    // The line answers "what did I miss", and nobody misses what they wrote.
    const rows = [
      m('a', ME, '2026-09-01T11:00:00Z'),
      m('b', 'them', '2026-09-01T12:00:00Z'),
    ];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:30:00Z')).toBe('b');
  });

  it('is nothing when everything has been read', () => {
    const rows = [m('a', 'them', '2026-09-01T10:00:00Z')];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:00:00Z')).toBeNull();
  });

  it('is nothing when the only unread messages are your own', () => {
    const rows = [m('a', ME, '2026-09-01T12:00:00Z')];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:00:00Z')).toBeNull();
  });

  it('treats a missing watermark as never read', () => {
    // No receipt row means this account has never opened the conversation on
    // any device, which is the one case where the whole thread is new.
    const rows = [
      m('a', ME, '2026-09-01T10:00:00Z'),
      m('b', 'them', '2026-09-01T11:00:00Z'),
    ];
    expect(firstUnreadId(rows, ME, null)).toBe('b');
  });

  it('picks the earliest unread whatever order the rows arrive in', () => {
    // A page merged in from a jump is prepended, and a divider that moved
    // because of how rows were loaded would point at the wrong message.
    const rows = [
      m('c', 'them', '2026-09-01T12:00:00Z'),
      m('b', 'them', '2026-09-01T11:00:00Z'),
    ];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:30:00Z')).toBe('b');
  });

  it('ignores a message stamped exactly at the watermark', () => {
    // The watermark is the last message read, not the first unread one.
    const rows = [m('a', 'them', '2026-09-01T10:00:00Z')];
    expect(firstUnreadId(rows, ME, '2026-09-01T10:00:00Z')).toBeNull();
  });

  it('is nothing in an empty thread', () => {
    expect(firstUnreadId([], ME, null)).toBeNull();
  });
});
