import { describe, expect, it } from 'vitest';
import { conversationsToPrefetch, PREFETCH_CONVERSATIONS } from './prefetch';

const at = (n: number) => `2026-01-0${n}T00:00:00Z`;

const list = [
  { peer_id: 'a', last_at: at(5) },
  { peer_id: 'b', last_at: at(4) },
  { peer_id: 'c', last_at: at(3) },
];

describe('conversationsToPrefetch', () => {
  it('takes the top of the list, which is where the next tap lands', () => {
    expect(conversationsToPrefetch(list, new Map(), new Set(), 2)).toEqual(['a', 'b']);
  });

  it('skips a conversation whose newest message is already on this device', () => {
    const cached = new Map([['a', at(5)]]);
    expect(conversationsToPrefetch(list, cached, new Set())).toEqual(['b', 'c']);
  });

  it('warms one whose cached page has fallen behind', () => {
    const cached = new Map([['a', at(2)]]);
    expect(conversationsToPrefetch(list, cached, new Set())).toContain('a');
  });

  it('skips a conversation nobody has written in', () => {
    const empty = [{ peer_id: 'vault', last_at: null }, ...list];
    expect(conversationsToPrefetch(empty, new Map(), new Set())).not.toContain('vault');
  });

  it('does not retry a peer already attempted this session', () => {
    expect(conversationsToPrefetch(list, new Map(), new Set(['a', 'b']))).toEqual(['c']);
  });

  it('never spends more than the cap, however long the list is', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ peer_id: `p${i}`, last_at: at(1) }));
    expect(conversationsToPrefetch(many, new Map(), new Set())).toHaveLength(
      PREFETCH_CONVERSATIONS
    );
  });

  it('returns nothing when everything is already held', () => {
    const cached = new Map(list.map((r) => [r.peer_id, r.last_at!]));
    expect(conversationsToPrefetch(list, cached, new Set())).toEqual([]);
  });
});
