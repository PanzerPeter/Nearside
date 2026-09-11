import { describe, expect, it } from 'vitest';
import { alertLevelFor, alertLevels, type ChatFlags } from './chat-flags';

function flags(entries: [string, ChatFlags['alertLevel']][]): Map<string, ChatFlags> {
  return new Map(
    entries.map(([id, alertLevel]) => [
      id,
      {
        id,
        kind: 'peer',
        pinnedAt: null,
        mutedAt: null,
        dismissedAt: null,
        archivedAt: null,
        unreadAt: null,
        alertLevel,
      },
    ])
  );
}

describe('alertLevelFor', () => {
  it('answers with the level a conversation was given', () => {
    expect(alertLevelFor('alice', flags([['alice', 'urgent']]))).toBe('urgent');
  });

  it('answers null for a conversation with no opinion on it', () => {
    expect(alertLevelFor('bob', flags([['alice', 'quiet']]))).toBeNull();
  });

  it('answers null for a conversation with a row but no level', () => {
    expect(alertLevelFor('alice', flags([['alice', null]]))).toBeNull();
  });
});

describe('alertLevels', () => {
  it('names only the conversations with a loudness of their own', () => {
    const map = alertLevels(
      flags([
        ['alice', 'urgent'],
        ['bob', null],
        ['carol', 'quiet'],
      ])
    );
    expect(map).toEqual({ alice: 'urgent', carol: 'quiet' });
  });

  it('is empty when nothing has been set', () => {
    expect(alertLevels(flags([['alice', null]]))).toEqual({});
  });

  it('is empty for an empty list, rather than undefined', () => {
    expect(alertLevels(new Map())).toEqual({});
  });
});
