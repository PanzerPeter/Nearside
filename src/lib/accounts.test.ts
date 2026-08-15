import { describe, expect, it } from 'vitest';
import {
  MAX_ACCOUNTS,
  parseRoster,
  removeAccount,
  sortRoster,
  switchTargets,
  upsertAccount,
  type StoredAccount,
} from './accounts';

const account = (userId: string, over: Partial<StoredAccount> = {}): StoredAccount => ({
  userId,
  display_name: userId,
  avatar_url: null,
  refresh_token: `token-${userId}`,
  last_used_at: 1,
  ...over,
});

describe('parseRoster', () => {
  it('reads back what was written', () => {
    const list = [account('a'), account('b', { last_used_at: 2 })];
    expect(parseRoster(JSON.stringify(list))).toEqual([
      account('b', { last_used_at: 2 }),
      account('a'),
    ]);
  });

  it('returns empty for absent, malformed and non-array input', () => {
    expect(parseRoster(null)).toEqual([]);
    expect(parseRoster('')).toEqual([]);
    expect(parseRoster('{ not json')).toEqual([]);
    expect(parseRoster('{"userId":"a"}')).toEqual([]);
    expect(parseRoster('"a string"')).toEqual([]);
  });

  it('drops a bad entry rather than the whole roster', () => {
    // The failure this guards: one entry written by an older build costing the
    // user every other account on the device.
    const raw = JSON.stringify([account('a'), { userId: 'b' }, null, 7, account('c')]);
    expect(parseRoster(raw).map((a) => a.userId)).toEqual(['a', 'c']);
  });

  it('requires a refresh token, which is the only reason an entry exists', () => {
    const raw = JSON.stringify([{ ...account('a'), refresh_token: '' }]);
    expect(parseRoster(raw)).toEqual([]);
  });

  it('keeps only the first of a duplicated id', () => {
    const raw = JSON.stringify([account('a', { display_name: 'first' }), account('a')]);
    const list = parseRoster(raw);
    expect(list).toHaveLength(1);
    expect(list[0].display_name).toBe('first');
  });

  it('fills in a missing name, avatar and timestamp', () => {
    const raw = JSON.stringify([{ userId: 'a', refresh_token: 't' }]);
    expect(parseRoster(raw)).toEqual([
      { userId: 'a', display_name: '', avatar_url: null, refresh_token: 't', last_used_at: 0 },
    ]);
  });
});

describe('sortRoster', () => {
  it('puts the most recently used first', () => {
    const list = [account('a', { last_used_at: 1 }), account('b', { last_used_at: 9 })];
    expect(sortRoster(list).map((a) => a.userId)).toEqual(['b', 'a']);
  });

  it('breaks a tie stably rather than letting rows swap between renders', () => {
    const list = [account('z', { last_used_at: 5 }), account('a', { last_used_at: 5 })];
    expect(sortRoster(list).map((a) => a.userId)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const list = [account('a', { last_used_at: 1 }), account('b', { last_used_at: 9 })];
    sortRoster(list);
    expect(list.map((a) => a.userId)).toEqual(['a', 'b']);
  });
});

describe('upsertAccount', () => {
  it('adds an account that is not there yet', () => {
    expect(upsertAccount([], account('a')).map((a) => a.userId)).toEqual(['a']);
  });

  it('replaces the token wholesale on a re-add', () => {
    // Supabase rotates the refresh token and invalidates the one it replaced.
    // A merge that kept the old one would store a spent token and the switch
    // would fail at exactly the moment it is needed.
    const list = [account('a', { refresh_token: 'old', last_used_at: 1 })];
    const next = upsertAccount(list, account('a', { refresh_token: 'new', last_used_at: 2 }));
    expect(next).toHaveLength(1);
    expect(next[0].refresh_token).toBe('new');
  });

  it('trims to the cap, dropping the least recently used', () => {
    let list: StoredAccount[] = [];
    for (let i = 0; i < MAX_ACCOUNTS + 2; i++) {
      list = upsertAccount(list, account(`u${i}`, { last_used_at: i }));
    }
    expect(list).toHaveLength(MAX_ACCOUNTS);
    expect(list.map((a) => a.userId)).not.toContain('u0');
    expect(list.map((a) => a.userId)).not.toContain('u1');
  });

  it('never trims the account being written', () => {
    let list: StoredAccount[] = [];
    for (let i = 0; i < MAX_ACCOUNTS; i++) {
      list = upsertAccount(list, account(`u${i}`, { last_used_at: 100 + i }));
    }
    // Stamped older than everything already stored, and still must survive:
    // this is the account the user is signed into right now.
    const next = upsertAccount(list, account('newcomer', { last_used_at: 0 }));
    expect(next.map((a) => a.userId)).toContain('newcomer');
    expect(next).toHaveLength(MAX_ACCOUNTS);
  });
});

describe('removeAccount', () => {
  it('drops the named account and leaves the rest', () => {
    const list = [account('a'), account('b')];
    expect(removeAccount(list, 'a').map((x) => x.userId)).toEqual(['b']);
  });

  it('is a no-op for an id that is not on the roster', () => {
    const list = [account('a')];
    expect(removeAccount(list, 'ghost')).toEqual(list);
  });
});

describe('switchTargets', () => {
  it('excludes whoever is signed in', () => {
    const list = [account('a', { last_used_at: 2 }), account('b', { last_used_at: 1 })];
    expect(switchTargets(list, 'a').map((x) => x.userId)).toEqual(['b']);
  });

  it('offers everything when nobody is signed in', () => {
    const list = [account('a'), account('b')];
    expect(switchTargets(list, null)).toHaveLength(2);
  });
});
