import { describe, expect, it } from 'vitest';
import { friendshipPairFilter } from './remove-contact';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

describe('friendshipPairFilter', () => {
  // A friendship is not ordered: two people who add each other in the same
  // minute produce A→B and B→A, and the client's check-then-insert is not
  // atomic. Deleting only the row this client knows about leaves the other one
  // 'accepted' — so the friendship the user just ended still satisfies every
  // policy that gates on it, including the one that lets them message you.
  it('matches the pair in both directions', () => {
    const filter = friendshipPairFilter(ME, PEER);
    expect(filter).toContain(`requester_id.eq.${ME},addressee_id.eq.${PEER}`);
    expect(filter).toContain(`requester_id.eq.${PEER},addressee_id.eq.${ME}`);
  });

  // Ids go into a PostgREST filter string. A value carrying a comma or a paren
  // would end the expression early and delete a wider set than the pair.
  it('refuses an id that is not a uuid', () => {
    expect(() => friendshipPairFilter(ME, 'x,addressee_id.neq.0')).toThrow();
    expect(() => friendshipPairFilter('', PEER)).toThrow();
  });
});
