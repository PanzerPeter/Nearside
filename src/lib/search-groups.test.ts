import { describe, expect, it } from 'vitest';
import { groupHits, visibleHits, HITS_PER_CONVERSATION } from './search-groups';
import type { CachedMessage } from './localdb';

function hit(id: string, peer: string, at: string): CachedMessage {
  return { id, peer_id: peer, user_id: 'me', text: 'pier', created_at: at, expires_at: null };
}

describe('groupHits', () => {
  it('puts every hit under its own conversation', () => {
    const groups = groupHits([
      hit('a', 'alice', '2026-08-06T12:00:00Z'),
      hit('b', 'bob', '2026-08-06T11:00:00Z'),
      hit('c', 'alice', '2026-08-06T10:00:00Z'),
    ]);
    expect(groups.map((g) => g.conversationId)).toEqual(['alice', 'bob']);
    expect(groups[0].hits.map((h) => h.id)).toEqual(['a', 'c']);
  });

  it('orders sections by their newest hit, not by how many they hold', () => {
    const groups = groupHits([
      hit('recent', 'bob', '2026-08-06T12:00:00Z'),
      hit('old1', 'alice', '2026-01-01T10:00:00Z'),
      hit('old2', 'alice', '2026-01-01T09:00:00Z'),
      hit('old3', 'alice', '2026-01-01T08:00:00Z'),
    ]);
    expect(groups.map((g) => g.conversationId)).toEqual(['bob', 'alice']);
  });

  it('keeps the order the hits arrived in within a section', () => {
    const groups = groupHits([
      hit('newest', 'alice', '2026-08-06T12:00:00Z'),
      hit('older', 'alice', '2026-08-06T09:00:00Z'),
    ]);
    expect(groups[0].hits.map((h) => h.id)).toEqual(['newest', 'older']);
  });

  it('takes the newest stamp even when the rows are not in order', () => {
    const groups = groupHits([
      hit('a', 'alice', '2026-01-01T00:00:00Z'),
      hit('b', 'alice', '2026-09-01T00:00:00Z'),
    ]);
    expect(groups[0].newestAt).toBe('2026-09-01T00:00:00Z');
  });

  it('has nothing to group when there were no hits', () => {
    expect(groupHits([])).toEqual([]);
  });
});

describe('visibleHits', () => {
  it('shows everything a small section holds, and holds nothing back', () => {
    const [group] = groupHits([hit('a', 'alice', '2026-08-06T12:00:00Z')]);
    expect(visibleHits(group)).toEqual({ shown: group.hits, more: 0 });
  });

  it('caps a chatty conversation so it cannot push the others off', () => {
    const many = Array.from({ length: HITS_PER_CONVERSATION + 3 }, (_, i) =>
      hit(`h${i}`, 'alice', `2026-08-0${i + 1}T12:00:00Z`)
    );
    const [group] = groupHits(many);
    const { shown, more } = visibleHits(group);
    expect(shown).toHaveLength(HITS_PER_CONVERSATION);
    expect(more).toBe(3);
  });
});
