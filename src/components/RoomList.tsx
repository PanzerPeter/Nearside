import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, Pin, PinOff, Plus, Users } from 'lucide-react';
import {
  listRooms,
  roomUnreadCounts,
  subscribeRoomChanges,
  subscribeRoomReads,
  type RoomSummary,
} from '../lib/rooms';
import { formatListTime } from '../lib/time';
import { formatUnread } from '../lib/receipts';
import { useConnection } from '../lib/connection';
import type { Identity } from '../lib/crypto/keys';
import { CreateRoomModal } from './CreateRoomModal';
import { useBlockRows } from '../hooks/useBlocks';
import { blockedByMe } from '../lib/blocks';
import { SwipeRow } from './SwipeRow';
import {
  isMuted,
  loadChatFlags,
  setMuted,
  setPinned,
  subscribeChatFlags,
  sortByFlags,
  type ChatFlags,
} from '../lib/chat-flags';
import { syncMutedIds } from '../lib/mute';
import { syncAlertLevels } from '../lib/alerts';
import { cachedPreview } from '../lib/localdb';
import { useT } from '../hooks/useT';
import { HANDLE_ZONE } from '../lib/row-handle';

interface RoomListProps {
  me: string;
  identity: Identity;
  selectedRoomId: string | null;
  onSelectRoom: (room: RoomSummary) => void;
  /** Reported after every *successful* load, never on a failed one: the list
   *  above uses it to decide whether this account is empty enough for the
   *  first-run card, and a read that failed is not a list that is empty. */
  /** Reported together, because both answer questions the list above owns:
   *  the count decides the first-run card, and the summaries are what lets a
   *  search result in a group be shown under the group's name. */
  onCountChange?: (count: number) => void;
  onRoomsChange?: (rooms: RoomSummary[]) => void;
  /** Render nothing while there are no rooms. Set only when the first-run card
   *  is on screen — it carries the create action in that state, so a section
   *  header explaining rooms to someone who has no contacts either is one
   *  empty-state paragraph too many. */
  hideWhenEmpty?: boolean;
  /** The create dialog is controlled from above, because the first-run card
   *  opens it while this section is hidden. */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}

/** The room list is one RPC, so a cheap poll is a sufficient backstop for the
 *  cases realtime misses — a room someone else created and added you to.
 *
 *  "Cheap" is per call: `rooms_for_me()` runs two correlated subqueries per
 *  room, and this used to run every 45 seconds for the life of the session
 *  whether or not anyone was looking at the app. The conversation list beside
 *  it has always been the two-speed poll below. */
const POLL_HEALTHY_MS = 150_000;
/** …and the cadence once realtime is known down, when a poll is the only thing
 *  that will ever show a room somebody just added you to. */
const POLL_DEGRADED_MS = 12_000;

export function RoomList({
  me,
  identity,
  selectedRoomId,
  onSelectRoom,
  onCountChange,
  onRoomsChange,
  hideWhenEmpty = false,
  creating,
  onCreatingChange,
}: RoomListProps) {
  const t = useT();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  /** First load attempt has finished, successfully or not. Nothing is drawn
   *  before it: every mount starts with an empty array, so painting the empty
   *  state straight away flashes "No rooms yet" at everyone who has rooms. A
   *  *failed* attempt still counts — the create button is more use than a
   *  section that never appears because one RPC is down. */
  const [settled, setSettled] = useState(false);
  /** This device's pins and mutes; see `lib/chat-flags.ts`. */
  const [flags, setFlags] = useState<Map<string, ChatFlags>>(new Map());
  const [openRail, setOpenRail] = useState<string | null>(null);

  const refreshFlags = useCallback(async () => {
    const next = await loadChatFlags();
    setFlags(next);
    // Rooms and peers share one muted set — a push carries a `roomId` where a
    // direct message carries a `senderId`, and the extension checks whichever
    // it finds against the same list.
    void syncMutedIds(me, next);
    // Beside the mute list, and for the same reason — see `lib/alerts.ts`.
    void syncAlertLevels(me, next);
  }, [me]);

  useEffect(() => {
    void refreshFlags();
    // Rooms and conversations keep one flag store between them, so a mute set
    // from either list has to reach the other — see `subscribeChatFlags`.
    return subscribeChatFlags(() => void refreshFlags());
  }, [refreshFlags]);

  const ordered = useMemo(
    () => sortByFlags(rooms.map((r) => ({ ...r, lastAt: r.last_at })), flags),
    [rooms, flags]
  );
  const { generation, live } = useConnection();
  /** Unread per group, from `room_receipts`. Empty until the first load. */
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  /** The last line of each group, from the mirror this device wrote as it
   *  decrypted. A group nobody has opened on this phone has no line here and
   *  falls back to its member count — the honest answer, since the server
   *  holds no bodies to ask for. */
  const [previews, setPreviews] = useState<Map<string, { text: string; from: string }>>(
    new Map()
  );
  /** The thread folds what somebody you blocked said in a group, so the list
   *  must not print it as the group's last line either. */
  const blockRows = useBlockRows();
  const blocked = useMemo(() => new Set(blockedByMe(blockRows, me)), [blockRows, me]);

  /** A group's last line, or its member count when this device has none to
   *  show — the honest answer, since the server holds no bodies to ask for. */
  function previewFor(room: RoomSummary): string {
    const line = previews.get(room.id);
    return line && !blocked.has(line.from)
      ? line.text
      : t('room.memberCount', { count: room.member_count });
  }

  // Live ref rather than a dep: the callback is re-created on every render of
  // the list above, and keying `load` on it would restart the poll each time.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  const onRoomsChangeRef = useRef(onRoomsChange);
  onRoomsChangeRef.current = onRoomsChange;

  const load = useCallback(async () => {
    try {
      const rows = await listRooms(identity);
      setRooms(rows);
      onCountChangeRef.current?.(rows.length);
      onRoomsChangeRef.current?.(rows);
      // After the list, not beside it: the counts are keyed on the ids this
      // read just returned, and a group that has gone should not be counted.
      setUnread(await roomUnreadCounts(me, rows.map((r) => r.id)));
      // Local reads, one per group: the mirror is the only place a group's
      // plaintext exists, and there is no server call that could answer this.
      const lines = new Map<string, { text: string; from: string }>();
      for (const row of rows) {
        const hit = await cachedPreview(row.id);
        if (hit?.text) lines.set(row.id, { text: hit.text, from: hit.user_id });
      }
      setPreviews(lines);
    } catch {
      // A read that failed is not a list that is empty — leave whatever is on
      // screen rather than blanking it, same as the conversation list does.
    } finally {
      setSettled(true);
    }
  }, [me, identity]);

  useEffect(() => {
    void load();
  }, [load, generation]);

  // Opening a group marks it read; without this the badge would sit there
  // until the next poll, which is up to a minute of the list disagreeing with
  // the screen the user just came back from.
  useEffect(() => subscribeRoomReads(() => void load()), [load]);
  // A rename or a new member, made on this device, shows in the list at once
  // rather than at the next poll.
  useEffect(() => subscribeRoomChanges(() => void load()), [load]);

  // Skipped while the app is hidden, like every other poll in the app: the
  // wake path refetches on return, so a backgrounded tab polling on is spent
  // requests for a list nobody can see. This was the one that did not check.
  useEffect(() => {
    const period = live ? POLL_HEALTHY_MS : POLL_DEGRADED_MS;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void load();
    }, period);
    return () => clearInterval(id);
  }, [load, live]);

  const empty = rooms.length === 0;

  return (
    <>
      {/* Section and row insets are chosen so the label, the room icons and the
          conversation avatars below all share one left edge. */}
      {settled && !(empty && hideWhenEmpty) && (
        <div className="px-2 pt-3">
          <div className="flex items-center justify-between pl-3 pr-1 mb-1">
            <p className="text-meta font-medium text-muted">
              {t('rooms.title')}
            </p>
            <button
              className="btn btn-ghost btn-xs btn-circle"
              onClick={() => onCreatingChange(true)}
              title={t('rooms.new')}
              aria-label={t('rooms.new')}
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {empty ? (
            <p className="px-2 text-meta text-muted pb-2">{t('rooms.empty')}</p>
          ) : (
            <ul className="space-y-0.5 pb-1">
              {ordered.map((room) => {
                const pinned = flags.get(room.id)?.pinnedAt != null;
                const muted = isMuted(room.id, flags);
                return (
                <li key={room.id} className="group/row">
                  {/* Rooms get pin and mute and no delete: leaving a room is
                      not a list action — it tells the other members — and it
                      lives inside the room where the membership does. */}
                  <SwipeRow
                    open={openRail === room.id}
                    onOpenChange={(open) => setOpenRail(open ? room.id : null)}
                    actions={[
                      {
                        key: 'pin',
                        label: pinned ? t('chatList.unpin') : t('chatList.pin'),
                        icon: pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />,
                        onClick: () => {
                          void setPinned(room.id, 'room', !pinned);
                        },
                      },
                      {
                        key: 'mute',
                        label: muted ? t('chatList.unmute') : t('chatList.mute'),
                        icon: muted ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />,
                        onClick: () => {
                          void setMuted(room.id, 'room', !muted);
                        },
                      },
                    ]}
                  >
                  {/* The same box, padding and selected treatment as a
                      conversation row, so a group and a person in the same
                      list read as the same kind of thing. */}
                  <button
                    className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-field text-left transition-colors ${
                      selectedRoomId === room.id ? 'bg-primary/10' : 'hover:bg-wash'
                    }`}
                    onClick={() => {
                      setOpenRail(null);
                      onSelectRoom(room);
                    }}
                  >
                    {selectedRoomId === room.id && (
                      <span className="brand-gradient absolute left-0 top-1/2 -translate-y-1/2 h-7 w-1 rounded-r-full" />
                    )}
                    <span className="w-10 h-10 rounded-box bg-primary/15 text-primary flex items-center justify-center shrink-0">
                      <Users className="w-[18px] h-[18px]" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-body font-medium truncate">{room.title}</span>
                      <span className="block text-meta text-muted truncate">
                        {previewFor(room)}
                      </span>
                    </span>
                    {muted && (
                      <BellOff className="w-3 h-3 shrink-0 text-subtle" aria-label={t('chatList.muted')} />
                    )}
                    {pinned && (
                      <Pin className="w-3 h-3 shrink-0 text-subtle" aria-label={t('chatList.pinned')} />
                    )}
                    {room.last_at && (
                      <span className={`text-micro tabular-nums text-subtle shrink-0 ${HANDLE_ZONE}`}>
                        {formatListTime(room.last_at)}
                      </span>
                    )}
                    {(unread.get(room.id) ?? 0) > 0 && (
                      <span
                        className={`shrink-0 min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-content text-micro font-bold tabular-nums leading-none ${HANDLE_ZONE}`}
                        aria-label={t('chatList.unread', { count: unread.get(room.id) ?? 0 })}
                      >
                        {formatUnread(unread.get(room.id) ?? 0)}
                      </span>
                    )}
                  </button>
                  </SwipeRow>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {creating && (
        <CreateRoomModal
          me={me}
          identity={identity}
          onCreated={(roomId) => {
            onCreatingChange(false);
            // Opened from the refreshed list rather than from a row built here:
            // the RPC is the only thing that knows the member count, and a
            // header reading "0 members" for a room that has three is the kind
            // of wrong that looks like a bug in the crypto.
            void listRooms(identity).then((rows) => {
              setRooms(rows);
              onCountChangeRef.current?.(rows.length);
              onRoomsChangeRef.current?.(rows);
              const room = rows.find((r) => r.id === roomId);
              if (room) onSelectRoom(room);
            });
          }}
          onClose={() => onCreatingChange(false)}
        />
      )}
    </>
  );
}
