import { useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { Modal } from './Modal';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { useT } from '../hooks/useT';

interface AskSealedModalProps {
  /** How to name the other participant, already formatted by the caller. */
  peerLabel: string;
  busy: boolean;
  onAsk: (question: string, answer: string) => void;
  onClose: () => void;
}

/**
 * Compose a sealed exchange: the question everyone sees, and the answer
 * nobody sees yet.
 *
 * Both fields are required, and that is the feature rather than validation
 * fussiness — a question sent without the asker's own answer would be an
 * ordinary question with extra steps, and the asker would be the one who gets
 * to read first.
 */
export function AskSealedModal({ peerLabel, busy, onAsk, onClose }: AskSealedModalProps) {
  const t = useT();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const questionRef = useRef<HTMLTextAreaElement>(null);

  const canSend = question.trim().length > 0 && answer.trim().length > 0 && !busy;

  return (
    <Modal
      title={t('chat.askSealed')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary gap-2"
            disabled={!canSend}
            onClick={() => onAsk(question.trim(), answer.trim())}
          >
            {busy ? <span className="loading loading-spinner loading-sm" /> : <Lock className="h-4 w-4" />}
            {t('sealed.sealAndSend')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-base-content/70">
          {t('sealed.intro', { name: peerLabel })}
        </p>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-base-content/60">
            {t('sealed.theQuestion')}
          </span>
          <textarea
            ref={questionRef}
            autoFocus
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            className="textarea w-full resize-none rounded-2xl border border-base-content/10 bg-base-300 leading-6 focus:border-primary/60 focus:outline-none"
            placeholder={t('sealed.questionPlaceholder')}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-base-content/60">
            <Lock className="h-3 w-3" />
            {t('sealed.yourAnswer')}
          </span>
          <textarea
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            className="textarea w-full resize-none rounded-2xl border border-base-content/10 bg-base-300 leading-6 focus:border-primary/60 focus:outline-none"
            placeholder={t('sealed.answerPlaceholder')}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>

        {/* The one thing about this feature a user cannot undo, said before
            they do it rather than in a toast afterwards. */}
        <p className="text-xs text-base-content/50">{t('sealed.warning')}</p>
      </div>
    </Modal>
  );
}
