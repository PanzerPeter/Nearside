import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { addMembers } from '../lib/rooms';
import type { Identity } from '../lib/crypto/keys';
import { useToast } from '../hooks/useToast';
import { useRoomCandidates } from '../hooks/useRoomCandidates';
import { MemberPicker } from './MemberPicker';
import { Modal } from './Modal';
import { useT } from '../hooks/useT';

interface AddMembersModalProps {
  me: string;
  identity: Identity;
  roomId: string;
  title: string;
  roomKey: Uint8Array;
  /** Already in the group, so not offered again. */
  memberIds: ReadonlySet<string>;
  /** Where the newcomers' name colours start, so they do not all repeat the
   *  first member's. */
  colourStart: number;
  onAdded: () => void;
  onClose: () => void;
}

/**
 * Owner-only: put more of your contacts into a group that already exists.
 *
 * The note above the list is not decoration. A newcomer reads from the moment
 * they join (0057), which is the opposite of what some messengers do, and it
 * is the server enforcing it rather than the encryption — both things the
 * person adding them should know before they press the button.
 */
export function AddMembersModal({
  me,
  identity,
  roomId,
  title,
  roomKey,
  memberIds,
  colourStart,
  onAdded,
  onClose,
}: AddMembersModalProps) {
  const t = useT();
  const toast = useToast();
  const candidates = useRoomCandidates(me);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const people = useMemo(
    () => candidates.people.filter((p) => !memberIds.has(p.id)),
    [candidates.people, memberIds]
  );

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    if (picked.size === 0) return;
    setBusy(true);
    try {
      const { added, skipped } = await addMembers(
        roomId,
        me,
        identity,
        roomKey,
        [...picked],
        colourStart
      );
      if (skipped.length > 0) toast.error(t('room.skippedMembers', { count: skipped.length }));
      if (added.length > 0) toast.success(t('room.addedToast'));
      onAdded();
    } catch {
      toast.error(t('room.addFailed'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('room.addTitle', { name: title })}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void add()}
            disabled={busy || picked.size === 0}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : t('room.addConfirm')}
          </button>
        </>
      }
    >
      <p className="flex gap-2 rounded-field bg-base-200/60 px-3 py-2.5 text-meta text-muted mb-4">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
        <span>{t('room.addNote')}</span>
      </p>

      <MemberPicker
        people={people}
        unreachable={candidates.unreachable}
        picked={picked}
        loading={candidates.loading}
        emptyLabel={t('room.addNobody')}
        onToggle={toggle}
      />
    </Modal>
  );
}
