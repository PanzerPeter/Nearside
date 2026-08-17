import { describe, expect, it } from 'vitest';
import { mutedIds } from './chat-flags';
import type { ChatFlags } from './chat-flags';

const flags = (entries: [string, string | null][]) =>
  new Map<string, ChatFlags>(
    entries.map(([id, mutedAt]) => [
      id,
      { id, kind: 'peer', pinnedAt: null, mutedAt, dismissedAt: null },
    ])
  );

// The set handed to the native store is the whole contract with the
// notification extension: anything in it is silenced while the app is dead, so
// a superset silences conversations the user never muted.
describe('the set handed to the notification extension', () => {
  it('lists exactly the muted ids', () => {
    expect(mutedIds(flags([['a', '2026-08-16T00:00:00Z'], ['b', null]]))).toEqual(['a']);
  });

  it('is stable in order, so an unchanged set does not rewrite native storage', () => {
    const f = flags([
      ['b', '2026-08-16T00:00:00Z'],
      ['a', '2026-08-16T00:00:00Z'],
    ]);
    expect(mutedIds(f)).toEqual(['a', 'b']);
  });

  it('is empty when nothing is muted', () => {
    expect(mutedIds(flags([['a', null]]))).toEqual([]);
  });
});
