// What a set of picked-out messages allows you to do with them.
//
// Acting on messages one at a time is fine until there are nine of them, and
// then it is nine confirmations and nine trips through the same menu. The rules
// below are the part worth writing down and testing: an action offered on a
// selection that cannot actually take it is an action that fails halfway
// through, having already deleted four of the nine.
//
// Pure, so those rules are settled in the node suite rather than by selecting
// things on a screen and watching.

/** What the caller needs to know about each picked message. */
export interface SelectableMessage {
  id: string;
  /** Whether this account wrote it. Only your own can be deleted. */
  isOwn: boolean;
  /** Whether it can be passed on — a queued message has no server row to copy
   *  from, and a group message that failed its signature check must not be
   *  re-signed as somebody else's. */
  forwardable: boolean;
}

export interface SelectionPowers {
  count: number;
  /** Every one of them is this account's, so a delete can go ahead. Mixed
   *  selections deliberately offer nothing rather than silently acting on the
   *  half they can: "delete 9" that removes 4 is worse than a greyed button. */
  canDelete: boolean;
  /** Every one of them can be forwarded. Same rule, same reason. */
  canForward: boolean;
}

/**
 * How many are selected and what may be done with all of them.
 *
 * An empty selection can do nothing, which is what closes the bar: leaving the
 * last message deselected is how somebody changes their mind, and it should not
 * take a second tap on Cancel.
 */
export function selectionPowers(picked: readonly SelectableMessage[]): SelectionPowers {
  return {
    count: picked.length,
    canDelete: picked.length > 0 && picked.every((m) => m.isOwn),
    canForward: picked.length > 0 && picked.every((m) => m.forwardable),
  };
}

/** `id` added, or removed if it was already there. A fresh set each time — the
 *  caller holds it in state, and mutating it in place renders nothing. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The selection with anything no longer in the thread dropped.
 *
 * The thread keeps moving while a selection is open — a message is deleted on
 * the other phone, a page is released — and an id left behind would be counted
 * in the bar and then quietly do nothing when the action ran.
 */
export function prunedSelection(
  selected: ReadonlySet<string>,
  present: readonly { id: string }[]
): Set<string> {
  const live = new Set(present.map((m) => m.id));
  return new Set([...selected].filter((id) => live.has(id)));
}
