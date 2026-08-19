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

import {
  allChatFlags,
  forgetChatFlags,
  setChatFlag,
  type ChatFlagsRow,
} from './localdb';

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
}

function fromRow(row: ChatFlagsRow): ChatFlags {
  return {
    id: row.id,
    kind: row.kind,
    pinnedAt: row.pinned_at,
    mutedAt: row.muted_at,
    dismissedAt: row.dismissed_at,
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

export async function forgetChat(id: string): Promise<void> {
  await forgetChatFlags(id);
  announce();
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
