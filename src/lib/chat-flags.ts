/**
 * Pin, mute and dismissal — this device's opinion about its own chat list.
 *
 * None of it reaches the server, and that is the feature rather than a
 * limitation. A pin list is a ranking of who matters to you; a mute list is a
 * list of people you are avoiding; a dismissal is a soft block. Held in
 * Postgres, each would be a fact about the user that the product otherwise
 * never learns, sitting in the one place a subpoena can reach. The cost is that
 * none of it follows you to a second device, which the settings copy says.
 *
 * Storage is `localdb.ts`, like every other local-only fact. The pure halves
 * live here so the node suite can reach the ordering and the filtering.
 */

import { allChatFlags, setChatFlag, type ChatFlagsRow } from './localdb';

/*
 * One place to hear that this device's opinion changed.
 *
 * The flags are written from screens that do not share a subtree with the list
 * that renders them — "Hidden requests" lives under the settings tab, and the
 * chat list stays mounted behind it. Without this, unhiding somebody left the
 * list holding the flags it had read on mount: the request that had been
 * hidden stayed hidden until the app was restarted, which is the one thing
 * that screen exists to undo.
 */
const listeners = new Set<() => void>();

export function subscribeChatFlags(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

export interface ChatFlags {
  id: string;
  kind: string;
  pinnedAt: string | null;
  mutedAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  /** When the conversation was marked unread by hand. See `isUnreadMarked`. */
  unreadAt: string | null;
  /** How loudly this one arrives, or null for however the app is set. */
  alertLevel: AlertLevel | null;
}

/**
 * How loudly one conversation arrives.
 *
 * Deliberately three states and not four: muting is a different question —
 * whether anything is shown at all — with its own flag, so that unmuting has a
 * loudness to go back to rather than having to guess one.
 *
 * 'quiet' shows the notification without a sound; 'urgent' asks the system to
 * put it in front of whatever is on screen. Both are hints: Android's per-app
 * notification settings are the final word, and a phone in Do Not Disturb owes
 * this app nothing.
 */
export type AlertLevel = 'quiet' | 'urgent';

function toLevel(raw: string | null | undefined): AlertLevel | null {
  return raw === 'quiet' || raw === 'urgent' ? raw : null;
}

function fromRow(row: ChatFlagsRow): ChatFlags {
  return {
    id: row.id,
    kind: row.kind,
    pinnedAt: row.pinned_at,
    mutedAt: row.muted_at,
    dismissedAt: row.dismissed_at,
    archivedAt: row.archived_at ?? null,
    unreadAt: row.unread_at ?? null,
    alertLevel: toLevel(row.alert_level),
  };
}

/** Everything this device has an opinion about, keyed by conversation id. */
export async function loadChatFlags(): Promise<Map<string, ChatFlags>> {
  const rows = await allChatFlags();
  return new Map([...rows].map(([id, row]) => [id, fromRow(row)]));
}

/** `on` stamps the moment rather than a boolean: the pins are ordered by when
 *  they were pinned, and a boolean would leave them in an arbitrary order. */
export async function setPinned(id: string, kind: 'peer' | 'room', on: boolean): Promise<void> {
  await setChatFlag(id, kind, 'pinned_at', on ? new Date().toISOString() : null);
  announce();
}

export async function setMuted(id: string, kind: 'peer' | 'room', on: boolean): Promise<void> {
  await setChatFlag(id, kind, 'muted_at', on ? new Date().toISOString() : null);
  announce();
}

export async function setDismissed(id: string, on: boolean): Promise<void> {
  await setChatFlag(id, 'peer', 'dismissed_at', on ? new Date().toISOString() : null);
  announce();
}

/**
 * Archive is a shelf, not a delete: the conversation, its history and its
 * notifications all carry on, it simply stops occupying a row in the list you
 * read every day. Muting silences; archiving tidies; they are different wants
 * and this app had only the first.
 */
export async function setArchived(id: string, kind: 'peer' | 'room', on: boolean): Promise<void> {
  await setChatFlag(id, kind, 'archived_at', on ? new Date().toISOString() : null);
  announce();
}

/**
 * Mark a conversation unread by hand, or take the mark off.
 *
 * Stamped rather than a boolean because the stamp is what lets a later message
 * clear it: a chat you left unread on purpose and then received something in is
 * unread for the ordinary reason, and the mark has done its job. Compared in
 * `isUnreadMarked` rather than here, so the comparison is testable.
 */
export async function setUnreadMark(id: string, kind: 'peer' | 'room', on: boolean): Promise<void> {
  await setChatFlag(id, kind, 'unread_at', on ? new Date().toISOString() : null);
  announce();
}

/**
 * How loudly one conversation should arrive, or null for the ordinary setting.
 *
 * Written to the local store and mirrored to native storage by
 * `lib/alerts.ts`, for the same reason the mute list is: a push arrives when
 * the WebView is not running, which is exactly when a preference held in
 * JavaScript is unreadable.
 */
export async function setAlertLevel(
  id: string,
  kind: 'peer' | 'room',
  level: AlertLevel | null
): Promise<void> {
  await setChatFlag(id, kind, 'alert_level', level);
  announce();
}

/** What this conversation is set to, or null for the ordinary setting. */
export function alertLevelFor(
  id: string,
  flags: ReadonlyMap<string, ChatFlags>
): AlertLevel | null {
  return flags.get(id)?.alertLevel ?? null;
}

/** Every conversation with a loudness of its own, as `{ id: level }`. What
 *  `lib/alerts.ts` hands to the notification extension. */
export function alertLevels(flags: ReadonlyMap<string, ChatFlags>): Record<string, AlertLevel> {
  const out: Record<string, AlertLevel> = {};
  for (const [id, flag] of flags) {
    if (flag.alertLevel) out[id] = flag.alertLevel;
  }
  return out;
}

interface Sortable {
  id: string;
  lastAt: string | null;
}

/**
 * Lift the pinned rows to the top, newest pin first, and leave the rest alone.
 *
 * Deliberately *not* a second full ordering: `sortConversations` in
 * `conversation.ts` already decided where the self-chat goes and how two
 * conversations stamped in the same second are broken apart, and a sort here
 * that re-derived any of that would be a second opinion to keep in step.
 */
export function sortByFlags<T extends Sortable>(
  rows: readonly T[],
  flags: ReadonlyMap<string, ChatFlags>
): T[] {
  const pinnedAt = (row: T) => flags.get(row.id)?.pinnedAt ?? null;
  const pinned = rows.filter((row) => pinnedAt(row) !== null);
  const rest = rows.filter((row) => pinnedAt(row) === null);
  pinned.sort((a, b) => (pinnedAt(a)! < pinnedAt(b)! ? 1 : -1));
  return [...pinned, ...rest];
}

/** The muted set, sorted so an unchanged set is byte-identical between passes
 *  and the native write can be skipped. */
export function mutedIds(flags: ReadonlyMap<string, ChatFlags>): string[] {
  return [...flags.values()]
    .filter((f) => f.mutedAt !== null)
    .map((f) => f.id)
    .sort();
}

export function isMuted(id: string, flags: ReadonlyMap<string, ChatFlags>): boolean {
  return flags.get(id)?.mutedAt != null;
}

export function isArchived(id: string, flags: ReadonlyMap<string, ChatFlags>): boolean {
  return flags.get(id)?.archivedAt != null;
}

/**
 * Whether a conversation should show as unread because somebody said so.
 *
 * The mark only counts while it is the newest thing about the conversation. A
 * message that arrived after it makes the chat unread on its own terms, and the
 * server's own count is then the truth — leaving the hand mark on top of that
 * would make "mark as read" fail to clear a row that has genuinely been read.
 */
export function isUnreadMarked(
  id: string,
  flags: ReadonlyMap<string, ChatFlags>,
  lastAt: string | null
): boolean {
  const markedAt = flags.get(id)?.unreadAt;
  if (!markedAt) return false;
  return !lastAt || lastAt <= markedAt;
}

/** Split a list into the everyday one and the shelf. Order is preserved in
 *  both, so whatever sorted the input still holds. */
export function partitionArchived<T extends { id: string }>(
  rows: readonly T[],
  flags: ReadonlyMap<string, ChatFlags>
): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const row of rows) (isArchived(row.id, flags) ? archived : active).push(row);
  return { active, archived };
}

interface Request {
  requester_id: string;
}

/** Pending friend requests, minus the people this device dismissed. */
export function visibleRequests<T extends Request>(
  requests: readonly T[],
  flags: ReadonlyMap<string, ChatFlags>
): T[] {
  return requests.filter((r) => flags.get(r.requester_id)?.dismissedAt == null);
}
