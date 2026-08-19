import { beforeEach, describe, expect, it } from 'vitest';
import {
  isMuted,
  mutedIds,
  setDismissed,
  setPinned,
  sortByFlags,
  subscribeChatFlags,
  visibleRequests,
  type ChatFlags,
} from './chat-flags';
import { clearLocalDb, openLocalDb } from './localdb';

const flag = (id: string, over: Partial<ChatFlags> = {}): [string, ChatFlags] => [
  id,
  { id, kind: 'peer', pinnedAt: null, mutedAt: null, dismissedAt: null, ...over },
];

describe('sortByFlags', () => {
  it('puts pinned rows above everything, however old', () => {
    const rows = [
      { id: 'fresh', lastAt: '2026-08-16T10:00:00Z' },
      { id: 'ancient', lastAt: '2024-01-01T00:00:00Z' },
    ];
    const flags = new Map([flag('ancient', { pinnedAt: '2026-08-16T09:00:00Z' })]);
    expect(sortByFlags(rows, flags).map((r) => r.id)).toEqual(['ancient', 'fresh']);
  });

  // Most recently pinned first, so pinning something moves it to the top of the
  // pins rather than into the middle of them.
  it('orders pins by when they were pinned', () => {
    const rows = [
      { id: 'a', lastAt: null },
      { id: 'b', lastAt: null },
    ];
    const flags = new Map([
      flag('a', { pinnedAt: '2026-08-01T00:00:00Z' }),
      flag('b', { pinnedAt: '2026-08-15T00:00:00Z' }),
    ]);
    expect(sortByFlags(rows, flags).map((r) => r.id)).toEqual(['b', 'a']);
  });

  // The list arrives already ordered by `sortConversations`, which knows about
  // the self-chat and about display names. Anything unpinned must come out of
  // here in exactly the order it went in.
  it('leaves unpinned rows in the order they arrived', () => {
    const rows = [
      { id: 'first', lastAt: '2026-08-01T00:00:00Z' },
      { id: 'second', lastAt: '2026-08-16T00:00:00Z' },
      { id: 'third', lastAt: null },
    ];
    expect(sortByFlags(rows, new Map()).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('leaves rows alone when their flags say nothing about pinning', () => {
    const rows = [{ id: 'a', lastAt: null }];
    const flags = new Map([flag('a', { mutedAt: '2026-08-16T00:00:00Z' })]);
    expect(sortByFlags(rows, flags).map((r) => r.id)).toEqual(['a']);
  });
});

describe('mutedIds', () => {
  it('lists exactly the muted ids, so the native set is never a superset', () => {
    const flags = new Map([flag('a', { mutedAt: '2026-08-16T00:00:00Z' }), flag('b')]);
    expect(mutedIds(flags)).toEqual(['a']);
  });

  it('is stable in order, so an unchanged set does not rewrite native storage', () => {
    const flags = new Map([
      flag('b', { mutedAt: '2026-08-16T00:00:00Z' }),
      flag('a', { mutedAt: '2026-08-16T00:00:00Z' }),
    ]);
    expect(mutedIds(flags)).toEqual(['a', 'b']);
  });
});

describe('isMuted', () => {
  it('is true only for a conversation with a mute stamp', () => {
    const flags = new Map([flag('a', { mutedAt: '2026-08-16T00:00:00Z' }), flag('b')]);
    expect(isMuted('a', flags)).toBe(true);
    expect(isMuted('b', flags)).toBe(false);
    expect(isMuted('unknown', flags)).toBe(false);
  });
});

describe('visibleRequests', () => {
  // Removal stops them messaging: messages_insert_sender needs an accepted
  // friendship. It does NOT stop them asking again — friendships_insert_own
  // only checks that the requester is themself, and an ex-contact still knows
  // your user id. Without this filter, "delete" leaves a person able to put a
  // row in front of you twenty times an hour.
  it('hides a request from someone this device dismissed', () => {
    const requests = [
      { id: 'r1', requester_id: 'a' },
      { id: 'r2', requester_id: 'b' },
    ];
    const flags = new Map([flag('a', { dismissedAt: '2026-08-16T00:00:00Z' })]);
    expect(visibleRequests(requests, flags).map((r) => r.id)).toEqual(['r2']);
  });

  it('shows everything when nobody has been dismissed', () => {
    const requests = [{ id: 'r1', requester_id: 'a' }];
    expect(visibleRequests(requests, new Map()).map((r) => r.id)).toEqual(['r1']);
  });
});

describe('flag changes are announced', () => {
  const ME = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    await openLocalDb(ME);
    await clearLocalDb();
  });

  // The chat list stays mounted behind the settings tab, so unhiding somebody
  // on the "Hidden requests" screen has to reach it. Without this it read the
  // flags once on mount and went on hiding the request until a restart — in
  // the one screen whose whole job is undoing a decline.
  it('tells a subscriber when a dismissal is lifted', async () => {
    let heard = 0;
    const stop = subscribeChatFlags(() => (heard += 1));
    await setDismissed('peer', true);
    await setDismissed('peer', false);
    expect(heard).toBe(2);
    stop();
  });

  it('covers pins and mutes too, so one mechanism carries them all', async () => {
    let heard = 0;
    const stop = subscribeChatFlags(() => (heard += 1));
    await setPinned('peer', 'peer', true);
    expect(heard).toBe(1);
    stop();
  });

  it('stops telling a subscriber that unsubscribed', async () => {
    let heard = 0;
    const stop = subscribeChatFlags(() => (heard += 1));
    stop();
    await setDismissed('peer', true);
    expect(heard).toBe(0);
  });
});
