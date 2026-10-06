import { describe, expect, it } from 'vitest';
import {
  joinNotices,
  placeNotices,
  renameNotice,
  timerNotice,
  type ThreadNotice,
} from './thread-notices';

const notice = (id: string, at: string): ThreadNotice => ({ id, kind: 'joined', label: id, at });

describe('placeNotices', () => {
  const sent = ['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T12:00:00Z'];

  it('puts a notice before the first message sent after it', () => {
    const placed = placeNotices(sent, [notice('a', '2026-10-01T10:30:00Z')], false);
    expect([...placed.keys()]).toEqual([1]);
  });

  it('keeps a message stamped at the same instant above the line', () => {
    const placed = placeNotices(sent, [notice('a', '2026-10-01T10:00:00Z')], false);
    expect([...placed.keys()]).toEqual([1]);
  });

  it('puts a notice newer than everything at the end', () => {
    const placed = placeNotices(sent, [notice('a', '2026-10-02T00:00:00Z')], false);
    expect(placed.get(3)?.map((n) => n.id)).toEqual(['a']);
  });

  it('keeps several notices at one place in time order', () => {
    const placed = placeNotices(
      sent,
      [notice('later', '2026-10-01T10:45:00Z'), notice('earlier', '2026-10-01T10:15:00Z')],
      false
    );
    expect(placed.get(1)?.map((n) => n.id)).toEqual(['earlier', 'later']);
  });

  it('draws an old notice at the top when that is the whole history', () => {
    const placed = placeNotices(sent, [notice('a', '2026-09-01T00:00:00Z')], false);
    expect([...placed.keys()]).toEqual([0]);
  });

  it('leaves out a notice from before the window while older pages are unloaded', () => {
    // At the top it would read as having just happened; it belongs further back.
    const placed = placeNotices(sent, [notice('a', '2026-09-01T00:00:00Z')], true);
    expect(placed.size).toBe(0);
  });

  it('places notices in an empty thread at the start', () => {
    const placed = placeNotices([], [notice('a', '2026-10-01T10:00:00Z')], false);
    expect([...placed.keys()]).toEqual([0]);
  });

  it('sorts a timestamp that will not parse to the end rather than dropping it', () => {
    const placed = placeNotices(sent, [notice('a', 'not a date')], false);
    expect(placed.get(3)?.map((n) => n.id)).toEqual(['a']);
  });
});

describe('timerNotice', () => {
  it('is empty with no change and one notice with one', () => {
    expect(timerNotice(null)).toEqual([]);
    expect(timerNotice({ label: 'x', at: '2026-10-01T10:00:00Z' })).toHaveLength(1);
  });
});

describe('joinNotices', () => {
  const founded = '2026-10-01T10:00:00.000001+00:00';
  const name = (id: string) => id.toUpperCase();

  it('says nothing about the people the group was made with', () => {
    const members = [
      { user_id: 'owner', joined_at: founded },
      { user_id: 'b', joined_at: founded },
    ];
    expect(joinNotices(members, 'owner', 'b', name)).toEqual([]);
  });

  it('names somebody added later', () => {
    const members = [
      { user_id: 'owner', joined_at: founded },
      { user_id: 'c', joined_at: '2026-10-03T09:00:00Z' },
    ];
    const [line] = joinNotices(members, 'owner', 'owner', name);
    expect(line.label).toBe('C was added');
    expect(line.at).toBe('2026-10-03T09:00:00Z');
  });

  it('tells a newcomer they were added, and skips arrivals before them', () => {
    const members = [
      { user_id: 'owner', joined_at: founded },
      { user_id: 'early', joined_at: '2026-10-02T09:00:00Z' },
      { user_id: 'me', joined_at: '2026-10-03T09:00:00Z' },
      { user_id: 'late', joined_at: '2026-10-04T09:00:00Z' },
    ];
    expect(joinNotices(members, 'owner', 'me', name).map((n) => n.label)).toEqual([
      'You were added',
      'LATE was added',
    ]);
  });

  it('draws nothing for a reader who is not in the member list yet', () => {
    expect(joinNotices([{ user_id: 'owner', joined_at: founded }], 'owner', 'me', name)).toEqual(
      []
    );
  });
});

describe('renameNotice', () => {
  const name = (id: string) => id.toUpperCase();

  it('is empty for a group still carrying the name it was made with', () => {
    expect(renameNotice('Trip', null, null, 'me', name)).toEqual([]);
  });

  it('names whoever renamed it, and says "you" for the reader', () => {
    expect(renameNotice('Trip', 'anna', '2026-10-01T10:00:00Z', 'me', name)[0].label).toBe(
      'ANNA renamed the group to “Trip”'
    );
    expect(renameNotice('Trip', 'me', '2026-10-01T10:00:00Z', 'me', name)[0].label).toBe(
      'You renamed the group to “Trip”'
    );
  });
});
