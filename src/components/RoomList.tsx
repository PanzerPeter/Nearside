import { useCallback, useEffect, useState } from 'react';
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
}

/** The room list is one RPC, so a cheap poll is a sufficient backstop for the
 *  cases realtime misses — a room someone else created and added you to. */
const POLL_MS = 45_000;

export function RoomList({ me, identity, selectedRoomId, onSelectRoom }: RoomListProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const { generation } = useConnection();

  const load = useCallback(async () => {
    try {
      setRooms(await listRooms());
    } catch {
      // A read that failed is not a list that is empty — leave whatever is on
      // screen rather than blanking it, same as the conversation list does.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, generation]);

  useEffect(() => {
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      <div className="px-3 sm:px-4 pt-3">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-base-content/55">
            Rooms
          </p>
          <button
            className="btn btn-ghost btn-xs btn-circle"
            onClick={() => setCreating(true)}
            title="New room"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {rooms.length === 0 ? (
          <p className="text-xs text-base-content/60 pb-2">
            No rooms yet. A room is a group conversation with one shared key.
          </p>
        ) : (
          <ul className="space-y-1 pb-1">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  className={`w-full flex items-center gap-2.5 p-2 rounded-xl text-left transition-colors ${
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

      {creating && (
        <CreateRoomModal
          me={me}
          identity={identity}
          onCreated={(roomId) => {
            setCreating(false);
            // Opened from the refreshed list rather than from a row built here:
            // the RPC is the only thing that knows the member count, and a
            // header reading "0 members" for a room that has three is the kind
            // of wrong that looks like a bug in the crypto.
            void listRooms().then((rows) => {
              setRooms(rows);
              const room = rows.find((r) => r.id === roomId);
              if (room) onSelectRoom(room);
            });
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
