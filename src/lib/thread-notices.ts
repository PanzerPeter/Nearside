// The one-line events a thread draws between messages: a timer changed,
// somebody was added to a group, a group was renamed.
//
// Each is a fact the server already holds as a row and a timestamp, never a
// message of its own: there is no "system message" table, and inventing one
// would put a second, unsigned author into a group whose every other line is
// signed. So the thread places them by time among the messages it has, which
// is all this module does.
import { t } from './i18n';
import type { TimerChange } from './disappearing';

export type NoticeKind = 'timer' | 'joined' | 'renamed';

export interface ThreadNotice {
  /** Stable across renders, for React's key. */
  id: string;
  kind: NoticeKind;
  label: string;
  /** When it happened, which is where it goes in the thread. */
  at: string;
}

export function timerNotice(change: TimerChange | null): ThreadNotice[] {
  return change ? [{ id: 'timer', kind: 'timer', label: change.label, at: change.at }] : [];
}

/**
 * Where each notice belongs in a thread ordered oldest first: before the first
 * message sent after it, or at the end when it is newer than all of them.
 * Several notices at one index keep their own order by time.
 *
 * With older pages still unloaded, a notice from before the oldest loaded
 * message is left out rather than pinned to the top of the window: it belongs
 * further back, and it appears there once the reader pages that far. Drawn at
 * the top, a year-old "Anna was added" reads as having just happened.
 *
 * A timestamp that will not parse is sorted to the end rather than dropped —
 * the line is worth showing in the wrong place, and not worth hiding over.
 */
export function placeNotices(
  createdAts: readonly string[],
  notices: readonly ThreadNotice[],
  hasOlder: boolean
): Map<number, ThreadNotice[]> {
  const placed = new Map<number, ThreadNotice[]>();
  const sorted = [...notices].sort((a, b) => timeOf(a.at) - timeOf(b.at));
  for (const notice of sorted) {
    const at = timeOf(notice.at);
    const index = createdAts.findIndex((iso) => {
      const sentAt = Date.parse(iso);
      return Number.isFinite(sentAt) && sentAt > at;
    });
    if (index === 0 && hasOlder) continue;
    const slot = index === -1 ? createdAts.length : index;
    const list = placed.get(slot);
    if (list) list.push(notice);
    else placed.set(slot, [notice]);
  }
  return placed;
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export interface MemberJoin {
  user_id: string;
  joined_at: string;
}

/**
 * "Anna was added", for everyone who arrived after the group was made.
 *
 * The founding members were inserted in one statement, so they share the
 * creator's `joined_at` to the microsecond (the server stamps it, 0057) and
 * none of them gets a line: a new group opening on "Anna was added, Bo was
 * added" would describe its own creation as a string of events.
 *
 * Only arrivals from the reader's own onward are drawn. The thread starts at
 * the moment they joined (the read policy, 0057), so anything earlier has no
 * messages to sit between, and would all pile up above their first one.
 */
export function joinNotices(
  members: readonly MemberJoin[],
  creatorId: string,
  me: string,
  nameFor: (userId: string) => string
): ThreadNotice[] {
  const founding =
    members.find((m) => m.user_id === creatorId)?.joined_at ??
    members.reduce<string | null>(
      (min, m) => (min === null || m.joined_at < min ? m.joined_at : min),
      null
    );
  const mine = members.find((m) => m.user_id === me)?.joined_at;
  if (!founding || !mine) return [];
  const foundedAt = Date.parse(founding);
  const myJoin = Date.parse(mine);

  return members
    .filter((m) => {
      const at = Date.parse(m.joined_at);
      return at > foundedAt && at >= myJoin;
    })
    .map((m) => ({
      id: `joined:${m.user_id}`,
      kind: 'joined' as const,
      label: m.user_id === me ? t('room.youWereAdded') : t('room.wasAdded', { name: nameFor(m.user_id) }),
      at: m.joined_at,
    }));
}

/** "Anna renamed the group to …", once, for the latest rename. Like the
 *  timer, `rooms` keeps only the current name and who set it last, so this is
 *  the whole history the app can honestly draw. */
export function renameNotice(
  title: string,
  setBy: string | null,
  setAt: string | null,
  me: string,
  nameFor: (userId: string) => string
): ThreadNotice[] {
  if (!setBy || !setAt) return [];
  const label =
    setBy === me
      ? t('room.youRenamed', { title })
      : t('room.renamed', { who: nameFor(setBy), title });
  return [{ id: 'renamed', kind: 'renamed', label, at: setAt }];
}
