import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { listRooms, type RoomSummary } from '../lib/rooms';
import { formatListTime } from '../lib/time';
import { useConnection } from '../lib/connection';
import type { Identity } from '../lib/crypto/keys';
import { CreateRoomModal } from './CreateRoomModal';

interface RoomListProps {
  me: string;
  identity: Identity;
  selectedRoomId: string | null;
  onSelectRoom: (room: RoomSummary) => void;
  /** Reported after every *successful* load, never on a failed one: the list
   *  above uses it to decide whether this account is empty enough for the
   *  first-run card, and a read that failed is not a list that is empty. */
  onCountChange?: (count: number) => void;
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
  hideWhenEmpty = false,
  creating,
  onCreatingChange,
}: RoomListProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  /** First load attempt has finished, successfully or not. Nothing is drawn
   *  before it: every mount starts with an empty array, so painting the empty
   *  state straight away flashes "No rooms yet" at everyone who has rooms. A
   *  *failed* attempt still counts — the create button is more use than a
   *  section that never appears because one RPC is down. */
  const [settled, setSettled] = useState(false);
  const { generation, live } = useConnection();

  // Live ref rather than a dep: the callback is re-created on every render of
  // the list above, and keying `load` on it would restart the poll each time.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  const load = useCallback(async () => {
    try {
      const rows = await listRooms();
      setRooms(rows);
      onCountChangeRef.current?.(rows.length);
    } catch {
      // A read that failed is not a list that is empty — leave whatever is on
      // screen rather than blanking it, same as the conversation list does.
    } finally {
      setSettled(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, generation]);

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
        <div className="px-2 sm:px-3 pt-3">
          <div className="flex items-center justify-between px-2 mb-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">
              Rooms
            </p>
            <button
              className="btn btn-ghost btn-xs btn-circle"
              onClick={() => onCreatingChange(true)}
              title="New room"
              aria-label="New room"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {empty ? (
            <p className="px-2 text-xs text-base-content/60 pb-2">
              No rooms yet. A room is a group conversation with one shared key.
            </p>
          ) : (
            <ul className="space-y-1 pb-1">
              {rooms.map((room) => (
                <li key={room.id}>
                  <button
                    className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left transition-colors ${
                      selectedRoomId === room.id
                        ? 'bg-primary/10 ring-1 ring-primary/25'
                        : 'hover:bg-base-content/5'
                    }`}
                    onClick={() => onSelectRoom(room)}
                  >
                    <span className="w-9 h-9 rounded-xl bg-primary/15 text-primary flex items-center justify-center shrink-0">
                      <Users className="w-4 h-4" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{room.title}</span>
                      <span className="block text-xs text-base-content/55 truncate">
                        {room.member_count} {room.member_count === 1 ? 'member' : 'members'}
                      </span>
                    </span>
                    {room.last_at && (
                      <span className="text-[11px] text-base-content/60 shrink-0">
                        {formatListTime(room.last_at)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
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
            void listRooms().then((rows) => {
              setRooms(rows);
              onCountChangeRef.current?.(rows.length);
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
