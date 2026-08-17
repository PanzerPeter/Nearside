import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';
import {
  MAX_NICKNAME_LENGTH,
  clearNickname,
  saveNickname,
  useNickname,
} from '../lib/nicknames';
import { Check, Trash2 } from 'lucide-react';
import { useT } from '../hooks/useT';

interface NicknameModalProps {
  me: string;
  peerId: string;
  /** The peer's real handle, shown as the thing a nickname replaces. */
  display_name: string;
  /** True when this is the self-chat, which is named rather than nicknamed. */
  isSelf?: boolean;
  onClose: () => void;
}

/** Set, change or remove the private nickname for one person. */
export function NicknameModal({
  me,
  peerId,
  display_name,
  isSelf = false,
  onClose,
}: NicknameModalProps) {
  const t = useT();
  const current = useNickname(peerId);
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  async function save() {
    setBusy(true);
    // An emptied field means "remove it", which is what the user just did to
    // the only field on screen — refusing that as invalid input would be
    // pedantic when the Remove button does exactly the same thing.
    const error = value.trim()
      ? await saveNickname(me, peerId, value)
      : await clearNickname(me, peerId);
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    onClose();
  }

  async function remove() {
    setBusy(true);
    const error = await clearNickname(me, peerId);
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    onClose();
  }

  return (
    <Modal
      title={isSelf ? t('chat.nameThisChat') : t('nickname.title')}
      onClose={onClose}
      actions={
        <>
          {current && (
            <button
              type="button"
              className="btn btn-ghost btn-sm text-error mr-auto"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 className="w-4 h-4" />
              {t('common.remove')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
            {busy ? <span className="loading loading-spinner loading-xs" /> : <Check className="w-4 h-4" />}
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={MAX_NICKNAME_LENGTH}
          placeholder={isSelf ? t('nickname.selfPlaceholder') : display_name}
          aria-label={
            isSelf ? t('nickname.selfLabel') : t('nickname.label', { name: display_name })
          }
          className="input input-bordered w-full bg-base-200/50 focus:border-primary"
        />
      </form>

      <p className="text-xs text-base-content/55 mt-3">
        {isSelf ? (
          t('nickname.selfNote')
        ) : (
          <>
            {t('nickname.notePrefix', { name: display_name })}{' '}
            <span className="font-medium text-base-content/70">@{display_name}</span>{' '}
            {t('nickname.noteSuffix')}
          </>
        )}
      </p>
    </Modal>
  );
}
