// Who reacted to a message, and with what.
//
// The chips above a bubble say how many; this says who. In a group that is the
// whole question — six people and four emoji is a chip row nobody can read
// back — and in a one-to-one it is the difference between "somebody liked it"
// and knowing which of the two of you did.
//
// Pure and name-free: names are resolved by the caller, because the two
// surfaces resolve them differently (a room has its own member list and colour
// per speaker; a thread has you and one peer). Passing a resolver in keeps this
// testable in the node suite, which has no components.

import type { Reaction } from './types';

/** One reactor, inside a group of people who chose the same emoji. */
export interface Reactor {
  userId: string;
  /** True for the viewer's own reaction. The row says so rather than the
   *  caller comparing ids again at render time. */
  mine: boolean;
  /** When it was added, so the list can be read in the order it happened. */
  at: string;
}

/** Everyone who chose one emoji. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  /** True when the viewer is one of them — the chip is drawn filled for the
   *  same fact, and both read it from here. */
  mine: boolean;
  reactors: Reactor[];
}

/**
 * Group a message's reactions by emoji, in the order the sheet lists them.
 *
 * Groups are ordered by count, then by whichever emoji was first used, so the
 * order does not shuffle as later reactions land on a tie. Within a group the
 * viewer's own reaction comes first and the rest stay in the order they
 * arrived: your own is the one you look for, and everybody else's is a small
 * history of who turned up.
 *
 * `created_at` is the server's stamp, so the ordering does not depend on any
 * participant's clock agreeing with any other's.
 */
export function groupReactions(reactions: readonly Reaction[], me: string): ReactionGroup[] {
  const byEmoji = new Map<string, Reactor[]>();
  for (const r of reactions) {
    const list = byEmoji.get(r.emoji) ?? [];
    list.push({ userId: r.user_id, mine: r.user_id === me, at: r.created_at });
    byEmoji.set(r.emoji, list);
  }

  const groups: ReactionGroup[] = [...byEmoji.entries()].map(([emoji, reactors]) => {
    const ordered = [...reactors].sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      return a.at.localeCompare(b.at);
    });
    return {
      emoji,
      count: ordered.length,
      mine: ordered.some((r) => r.mine),
      reactors: ordered,
    };
  });

  return groups.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    // A stable tiebreak, and the meaningful one: the emoji somebody reached for
    // first. Comparing the emoji strings instead would order by code point,
    // which is an order nobody in the conversation can see a reason for.
    return firstAt(a).localeCompare(firstAt(b));
  });
}

/** When this emoji was first used on the message. */
function firstAt(group: ReactionGroup): string {
  return group.reactors.reduce(
    (earliest, r) => (r.at < earliest ? r.at : earliest),
    group.reactors[0]?.at ?? ''
  );
}

/**
 * The total, for the sheet's heading.
 *
 * Not `reactions.length` at the call site: one person may react with three
 * different emoji, and a heading saying "3 reactions" over a list of one name
 * repeated is the number being right and useless. This counts reactions, which
 * is what the chips count too — the two must not disagree.
 */
export function reactionCount(groups: readonly ReactionGroup[]): number {
  return groups.reduce((total, g) => total + g.count, 0);
}
