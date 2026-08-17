import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { createRoom, unreachableMembers } from '../lib/rooms';
import { formatDisplayName, nicknameFor } from '../lib/nicknames';
import type { Identity } from '../lib/crypto/keys';
import type { Profile } from '../lib/types';
import { useToast } from '../hooks/useToast';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { useT } from '../hooks/useT';

interface CreateRoomModalProps {
  me: string;
  identity: Identity;
  onCreated: (roomId: string) => void;
  onClose: () => void;
}

const TITLE_MAX = 60;

/**
 * A room can only invite people you are already connected to.
 *
 * Not a policy choice — sealing the room key needs their published public key,
 * and there is no directory to look one up in. Someone whose key has not
 * published yet is shown as unavailable with the reason rather than silently
 * dropped: a room quietly missing a member is worse than one that refuses to
 * be created.
 */
export function CreateRoomModal({ me, identity, onCreated, onClose }: CreateRoomModalProps) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [friends, setFriends] = useState<Profile[]>([]);
  const [unreachable, setUnreachable] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${me},addressee_id.eq.${me}`);

      const peerIds = [
        ...new Set(
          (data ?? [])
            .map((f) => (f.requester_id === me ? f.addressee_id : f.requester_id))
            .filter((id) => id !== me)
        ),
      ];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url')
        .in('id', peerIds.length ? peerIds : ['00000000-0000-0000-0000-000000000000']);

      const blocked = await unreachableMembers(peerIds);
      if (!alive) return;
      setFriends((profiles as Profile[] | null) ?? []);
      setUnreachable(new Set(blocked));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [me]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    const trimmed = title.trim();
    if (!trimmed || picked.size === 0) return;
    setBusy(true);
    try {
      const { roomId, skipped } = await createRoom(me, identity, trimmed, [...picked]);
      if (skipped.length > 0) {
        toast.error(t('room.skippedMembers', { count: skipped.length }));
      }
      onCreated(roomId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('room.createFailed'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('rooms.new')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={busy || !title.trim() || picked.size === 0}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-control">
        <label className="label pb-1" htmlFor="room-title">
          <span className="label-text text-xs font-medium uppercase tracking-wider text-base-content/60">
            {t('room.name')}
          </span>
        </label>
        <input
          id="room-title"
          type="text"
          className="input w-full bg-base-200/50 border border-base-content/10 focus:border-primary"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('room.namePlaceholder')}
        />
        <span className="text-xs text-base-content/55 mt-1">{t('room.nameNote')}</span>
      </div>

      <div className="divider my-4" />

      <p className="text-xs font-medium uppercase tracking-wider text-base-content/60 mb-2">
        Members ({picked.size})
      </p>

      {loading ? (
        <div className="flex justify-center py-8">
          <span className="loading loading-spinner" />
        </div>
      ) : friends.length === 0 ? (
        <p className="text-sm text-base-content/60 py-6 text-center">
          Connect with someone first. A room can only include people you are connected to.
        </p>
      ) : (
        <ul className="space-y-1 max-h-64 overflow-y-auto">
          {friends.map((f) => {
            const blocked = unreachable.has(f.id);
            return (
              <li key={f.id}>
                <button
                  type="button"
                  className={`w-full flex items-center gap-2.5 p-2 rounded-lg text-left transition-colors ${
                    blocked
                      ? 'opacity-50 cursor-not-allowed'
                      : picked.has(f.id)
                        ? 'bg-primary/10 ring-1 ring-primary/30'
                        : 'hover:bg-base-content/5'
                  }`}
                  disabled={blocked}
                  onClick={() => toggle(f.id)}
                >
                  <Avatar display_name={f.display_name} url={f.avatar_url} size={32} />
                  <span className="flex-1 min-w-0 truncate text-sm">
                    {formatDisplayName(nicknameFor(f.id), f.display_name)}
                  </span>
                  {blocked ? (
                    <span className="text-[11px] text-base-content/55 shrink-0">
                      no key published
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      className="checkbox checkbox-primary checkbox-sm pointer-events-none shrink-0"
                      checked={picked.has(f.id)}
                      readOnly
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
