// Folding a group's messages from somebody you blocked.
//
// A block is a 1:1 thing, enforced by the database on every write into a pair's
// conversation (0053). A group has more than two people in it, and one member's
// block cannot stop the others hearing someone, so the server keeps delivering
// their group messages — to you as well. What the app can do is not make you
// read them: each run of consecutive messages from that person folds into one
// line you can open. Nothing is deleted or reported; it is your screen, not
// the group's.

export interface HiddenRun {
  sender: string;
  /** How many messages the line stands for. */
  count: number;
}

/**
 * For each message that opens a run from a hidden sender, the run it opens;
 * for every other message in that run, `null` (draw nothing). Messages from
 * anyone else are absent from the map.
 *
 * `breaksBefore(i)` says the thread draws something above message `i` — a
 * date, the unread line, a notice — and a run never reaches across one: a line
 * reading "2 messages" above a "Today" divider with nothing under it puts one
 * of them on the wrong day.
 */
export function hiddenRuns(
  messages: readonly { id: string; user_id: string }[],
  hidden: ReadonlySet<string>,
  breaksBefore: (index: number) => boolean = () => false
): Map<string, HiddenRun | null> {
  const runs = new Map<string, HiddenRun | null>();
  if (hidden.size === 0) return runs;
  let open: HiddenRun | null = null;
  for (const [i, m] of messages.entries()) {
    if (!hidden.has(m.user_id)) {
      open = null;
      continue;
    }
    if (open && open.sender === m.user_id && !breaksBefore(i)) {
      open.count += 1;
      runs.set(m.id, null);
    } else {
      open = { sender: m.user_id, count: 1 };
      runs.set(m.id, open);
    }
  }
  return runs;
}

/**
 * Runs of two or more consecutive deleted messages, shaped like `hiddenRuns`:
 * the first message of each run maps to its count, the rest to `null`.
 *
 * One deletion keeps its own bubble, on its own side, because that is the
 * only way to tell who took it back. Past one the bubbles say nothing new —
 * a conversation where somebody cleared a paragraph read as a wall of
 * identical grey cards — so the run folds into one line, and never across a
 * date or a divider for the same reason a hidden run does not.
 */
export function deletedRuns(
  messages: readonly { id: string; deleted_at?: string | null }[],
  breaksBefore: (index: number) => boolean = () => false
): Map<string, number | null> {
  const runs = new Map<string, number | null>();
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start >= 2) {
      runs.set(messages[start].id, end - start);
      for (let j = start + 1; j < end; j++) runs.set(messages[j].id, null);
    }
    start = -1;
  };
  for (const [i, m] of messages.entries()) {
    if (!m.deleted_at) {
      close(i);
      continue;
    }
    if (start >= 0 && breaksBefore(i)) close(i);
    if (start < 0) start = i;
  }
  close(messages.length);
  return runs;
}
