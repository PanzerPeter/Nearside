import { useState } from 'react';
import { createRoom } from '../lib/rooms';
import type { Identity } from '../lib/crypto/keys';
import { useToast } from '../hooks/useToast';
import { useRoomCandidates } from '../hooks/useRoomCandidates';
import { MemberPicker } from './MemberPicker';
import { Modal } from './Modal';
import { useT } from '../hooks/useT';
import { toggleSelected } from '../lib/selection';

interface CreateRoomModalProps {
  me: string;
  identity: Identity;
  onCreated: (roomId: string) => void;
  onClose: () => void;
}

const TITLE_MAX = 60;

/**
 * A room can only invite people you are already connected to — see
 * `useRoomCandidates`. Someone whose key has not published yet is shown as
 * unavailable with the reason rather than silently dropped: a room quietly
 * missing a member is worse than one that refuses to be created.
 */
export function CreateRoomModal({ me, identity, onCreated, onClose }: CreateRoomModalProps) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const candidates = useRoomCandidates(me);

  function toggle(id: string) {
    setPicked((prev) => toggleSelected(prev, id));
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
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void create()}
            disabled={busy || !title.trim() || picked.size === 0}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : t('rooms.create')}
          </button>
        </>
      }
    >
      <div className="flex flex-col">
        <label className="flex select-none items-center justify-between pb-1" htmlFor="room-title">
          <span className="text-meta font-medium text-muted">
            {t('room.name')}
          </span>
        </label>
        <input
          id="room-title"
          type="text"
          className="input w-full bg-base-200/50 border border-hairline focus:border-primary"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('room.namePlaceholder')}
        />
        <span className="text-meta text-muted mt-1">{t('room.nameNote')}</span>
      </div>

      <div className="divider my-4" />

      <p className="text-meta font-medium text-muted mb-2">
        {t('room.membersPicked', { count: picked.size })}
      </p>

      <MemberPicker
        people={candidates.people}
        unreachable={candidates.unreachable}
        picked={picked}
        loading={candidates.loading}
        emptyLabel={t('rooms.connectFirst')}
        onToggle={toggle}
      />
    </Modal>
  );
}
