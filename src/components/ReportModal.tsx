import { useState } from 'react';
import { Flag } from 'lucide-react';
import { Modal } from './Modal';
import { REPORT_REASON_MAX } from '../lib/report';
import { useT } from '../hooks/useT';

interface ReportModalProps {
  peerLabel: string;
  /** How many messages would go with the report — the conversation may hold
   *  fewer than the limit. Zero hides the choice, since there is nothing to
   *  include. */
  messageCount: number;
  /** Already blocked by this account: the "also block" choice has nothing to do. */
  alreadyBlocked: boolean;
  /** Resolves true once the report is sent; the modal closes itself then. */
  onSend: (reason: string, includeMessages: boolean, alsoBlock: boolean) => Promise<boolean>;
  onClose: () => void;
}

/**
 * Report a contact to the Nearside team.
 *
 * Including the messages is a choice, ticked by default and explained beside
 * the box: they are end-to-end encrypted, so this is the only way anyone other
 * than the two people in the conversation ever reads them, and the reporter
 * should know that is what the tick does.
 */
export function ReportModal({
  peerLabel,
  messageCount,
  alreadyBlocked,
  onSend,
  onClose,
}: ReportModalProps) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [includeMessages, setIncludeMessages] = useState(messageCount > 0);
  const [alsoBlock, setAlsoBlock] = useState(!alreadyBlocked);
  const [busy, setBusy] = useState(false);

  const canSend = reason.trim().length > 0 && !busy;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    const sent = await onSend(reason.trim(), includeMessages, alsoBlock && !alreadyBlocked);
    setBusy(false);
    if (sent) onClose();
  }

  return (
    <Modal
      title={t('report.title', { name: peerLabel })}
      onClose={() => (busy ? undefined : onClose())}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-error gap-2"
            disabled={!canSend}
            onClick={() => void send()}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : <Flag className="h-4 w-4" />}
            {t('report.send')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-meta font-medium uppercase tracking-wide text-muted">
            {t('report.reasonLabel')}
          </span>
          <textarea
            autoFocus
            rows={4}
            maxLength={REPORT_REASON_MAX}
            className="textarea w-full resize-none rounded-box border border-hairline bg-base-300 leading-6 focus:border-primary/60 focus:outline-hidden"
            placeholder={t('report.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>

        {messageCount > 0 && (
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={includeMessages}
              onChange={(e) => setIncludeMessages(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-body">
                {t('report.includeMessages', { count: messageCount })}
              </span>
              <span className="block text-meta text-subtle mt-0.5">{t('report.includeHint')}</span>
            </span>
          </label>
        )}

        {!alreadyBlocked && (
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={alsoBlock}
              onChange={(e) => setAlsoBlock(e.target.checked)}
            />
            <span className="text-body">{t('report.alsoBlock', { name: peerLabel })}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
