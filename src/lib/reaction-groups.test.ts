import { describe, expect, it } from 'vitest';
import { groupReactions, reactionCount } from './reaction-groups';
import type { Reaction } from './types';

const ME = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAT = '33333333-3333-3333-3333-333333333333';

let seq = 0;
function reaction(userId: string, emoji: string, at: string): Reaction {
  return {
    id: `r${++seq}`,
    message_id: 'm1',
    user_id: userId,
    emoji,
    created_at: at,
  };
}

describe('groupReactions', () => {
  it('is empty for a message nobody reacted to', () => {
    expect(groupReactions([], ME)).toEqual([]);
  });

  it('gathers everybody who chose the same emoji', () => {
    const groups = groupReactions(
      [
        reaction(BOB, '👍', '2026-09-01T10:00:00Z'),
        reaction(CAT, '👍', '2026-09-01T10:00:01Z'),
      ],
      ME
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].reactors.map((r) => r.userId)).toEqual([BOB, CAT]);
  });

  // One person may react with several emoji, so the number of reactors is not
  // the number of reactions and the two must never be conflated.
  it("keeps one person's several emoji in separate groups", () => {
    const groups = groupReactions(
      [
        reaction(BOB, '👍', '2026-09-01T10:00:00Z'),
        reaction(BOB, '🎉', '2026-09-01T10:00:01Z'),
      ],
      ME
    );
    expect(groups).toHaveLength(2);
    expect(reactionCount(groups)).toBe(2);
  });

  it("marks the viewer's own reaction, on the reactor and on the group", () => {
    const groups = groupReactions([reaction(ME, '👍', '2026-09-01T10:00:00Z')], ME);
    expect(groups[0].mine).toBe(true);
    expect(groups[0].reactors[0].mine).toBe(true);
  });

  it('does not claim a group is yours when somebody else chose that emoji', () => {
    const groups = groupReactions([reaction(BOB, '👍', '2026-09-01T10:00:00Z')], ME);
    expect(groups[0].mine).toBe(false);
  });

  // Yours is the one you are looking for in a list of six names.
  it('puts your own reaction first within its group', () => {
    const groups = groupReactions(
      [
        reaction(BOB, '👍', '2026-09-01T10:00:00Z'),
        reaction(CAT, '👍', '2026-09-01T10:00:01Z'),
        reaction(ME, '👍', '2026-09-01T10:00:02Z'),
      ],
      ME
    );
    expect(groups[0].reactors.map((r) => r.userId)).toEqual([ME, BOB, CAT]);
  });

  it('keeps everybody else in the order they arrived', () => {
    const groups = groupReactions(
      [
        reaction(CAT, '👍', '2026-09-01T10:00:05Z'),
        reaction(BOB, '👍', '2026-09-01T10:00:01Z'),
      ],
      ME
    );
    expect(groups[0].reactors.map((r) => r.userId)).toEqual([BOB, CAT]);
  });

  it('lists the most-used emoji first', () => {
    const groups = groupReactions(
      [
        reaction(BOB, '🎉', '2026-09-01T10:00:00Z'),
        reaction(BOB, '👍', '2026-09-01T10:00:01Z'),
        reaction(CAT, '👍', '2026-09-01T10:00:02Z'),
      ],
      ME
    );
    expect(groups.map((g) => g.emoji)).toEqual(['👍', '🎉']);
  });

  // A tie broken by the emoji's code point is an order nobody in the
  // conversation can see a reason for, and one that shuffles as reactions land.
  it('breaks a tie by which emoji was used first', () => {
    const groups = groupReactions(
      [
        reaction(BOB, '🎉', '2026-09-01T10:00:00Z'),
        reaction(CAT, '👍', '2026-09-01T10:00:05Z'),
      ],
      ME
    );
    expect(groups.map((g) => g.emoji)).toEqual(['🎉', '👍']);
  });

  it('does not reorder the input it was given', () => {
    const rows = [
      reaction(CAT, '👍', '2026-09-01T10:00:05Z'),
      reaction(BOB, '👍', '2026-09-01T10:00:01Z'),
    ];
    const before = rows.map((r) => r.id);
    groupReactions(rows, ME);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe('reactionCount', () => {
  it('is zero for nothing', () => {
    expect(reactionCount([])).toBe(0);
  });

  // The heading and the chips count the same thing, or one of them is lying.
  it('counts reactions rather than people', () => {
    const groups = groupReactions(
      [
        reaction(BOB, '👍', '2026-09-01T10:00:00Z'),
        reaction(BOB, '🎉', '2026-09-01T10:00:01Z'),
        reaction(CAT, '👍', '2026-09-01T10:00:02Z'),
      ],
      ME
    );
    expect(reactionCount(groups)).toBe(3);
  });
});
