import { describe, expect, it } from 'vitest';
import { MAX_BIO_LENGTH } from './bio';
import {
  DISPLAY_NAME_MAX,
  decodeProfile,
  encodeProfile,
  grantPlan,
  normalizeDisplayName,
} from './profile-shape';

const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('profile shape', () => {
  it('round-trips a profile', () => {
    const profile = {
      display_name: 'Peter',
      bio: 'line one\nline two',
      avatar: { path: `${OWNER}/x.bin`, key: 'a2V5' },
    };
    expect(decodeProfile(encodeProfile(profile), OWNER)).toEqual(profile);
  });

  it('applies the old column limits to what it opens', () => {
    const long = encodeProfile({ display_name: 'x'.repeat(500), bio: 'y'.repeat(900), avatar: null });
    const opened = decodeProfile(long, OWNER)!;
    expect(opened.display_name).toHaveLength(DISPLAY_NAME_MAX);
    expect(opened.bio).toHaveLength(MAX_BIO_LENGTH);
  });

  it('drops a picture outside the owner’s own folder', () => {
    const text = encodeProfile({
      display_name: 'Mallory',
      bio: null,
      avatar: { path: 'bbbbbbbb-0000-0000-0000-000000000002/theirs.bin', key: 'k' },
    });
    expect(decodeProfile(text, OWNER)?.avatar).toBeNull();
  });

  it('refuses what is not a profile', () => {
    expect(decodeProfile('not json', OWNER)).toBeNull();
    expect(decodeProfile('{"v":2,"n":"x"}', OWNER)).toBeNull();
    expect(decodeProfile('{"v":1,"n":"   "}', OWNER)).toBeNull();
  });

  it('keeps a name to one line', () => {
    expect(normalizeDisplayName(' a\tb\nc ')).toBe('a b c');
    expect(normalizeDisplayName('\n')).toBeNull();
  });
});

describe('grantPlan', () => {
  it('only adds the newcomers while nobody has left', () => {
    expect(grantPlan(new Set(['a', 'b', 'c']), new Set(['a']))).toEqual({
      add: ['b', 'c'],
      remove: [],
      rotate: false,
    });
  });

  it('rotates when anybody leaves, and grants everyone left again', () => {
    expect(grantPlan(new Set(['a', 'c']), new Set(['a', 'b']))).toEqual({
      add: ['a', 'c'],
      remove: ['b'],
      rotate: true,
    });
  });
});
