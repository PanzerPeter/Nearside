import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Lock, Trash2, Unlock } from 'lucide-react';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { motionDuration } from '../lib/motion';
import { exchangeState, splitAnswers, type OpenedAnswer } from '../lib/sealed-exchange';
import type { Message } from '../lib/types';

interface SealedExchangeProps {
  msg: Message;
  me: string;
  /** How to name the other participant, already formatted by the caller. */
  peerLabel: string;
  isOwn: boolean;
  answers: OpenedAnswer[];
  busy: boolean;
  onAnswer: (promptId: string, text: string) => void;
  /** Withdraw an unanswered question. Only offered to the asker, and only
   *  while it is still unanswered — after the reveal there is nothing left to
   *  withdraw. */
  onCancel: (msg: Message) => void;
  formatTime: (s: string) => string;
}

/**
 * One sealed exchange, as a card in the middle of the thread rather than as a
 * bubble on one side.
 *
 * It sits in the middle because it belongs to both people: the question is one
 * person's, but the thing on screen is a two-sided object with a state, and
 * hanging it off the asker's edge would make the reader's own half look like a
 * reply to it.
 */
export function SealedExchange({
  msg,
  me,
  peerLabel,
  isOwn,
  answers,
  busy,
  onAnswer,
  onCancel,
  formatTime,
}: SealedExchangeProps) {
  const [draft, setDraft] = useState('');
  const state = exchangeState(me, answers);
  const { mine, theirs } = splitAnswers(me, answers);

  // The reveal sweep, fired on the transition into `revealed` and on nothing
  // else — a card loaded from history mounts already revealed, so opening a
  // conversation must not cascade it down the thread.
  const [revealing, setRevealing] = useState(false);
  const previousState = useRef(state);
  useEffect(() => {
    const was = previousState.current;
    previousState.current = state;
    if (was === 'revealed' || state !== 'revealed') return;
    const ms = motionDuration('seal');
    if (ms === 0) return;
    setRevealing(true);
    const timer = window.setTimeout(() => setRevealing(false), ms);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (msg.deleted_at) {
    return (
      <div className="my-3 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-base-300/80 px-3 py-1 text-[0.7rem] font-medium text-base-content/60 ring-1 ring-base-content/5 backdrop-blur-sm">
          <Lock className="h-3 w-3 shrink-0" />
          {isOwn ? 'You withdrew a sealed question' : `${peerLabel} withdrew a sealed question`}
        </span>
      </div>
    );
  }

  const asker = isOwn ? 'You' : peerLabel;

  return (
    <div className="my-3 flex justify-center">
      <div
        className={`relative w-full max-w-md overflow-hidden rounded-2xl bg-base-100 p-4 shadow-sm ring-1 ${
          state === 'revealed' ? 'ring-primary/30' : 'ring-base-content/10'
        } ${revealing ? 'seal-sweep' : ''}`}
      >
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              state === 'revealed' ? 'bg-primary/15 text-primary' : 'bg-base-300 text-base-content/60'
            }`}
          >
            {state === 'revealed' ? (
              <Unlock className="h-[14px] w-[14px]" />
            ) : (
              <Lock className="h-[14px] w-[14px]" />
            )}
          </span>
          <span className="text-xs font-medium text-base-content/60">
            {asker} asked, sealed
          </span>
          <span className="ml-auto text-[0.7rem] text-base-content/40">
            {formatTime(msg.created_at)}
          </span>
        </div>

        {msg.decrypt_failed ? (
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            This question could not be opened on this device.
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[0.95rem] font-medium leading-6">
            {msg.text}
          </p>
        )}

        {state === 'awaiting_you' && (
          <div className="mt-3">
            <textarea
              rows={2}
              maxLength={MAX_MESSAGE_LENGTH}
              className="textarea w-full resize-none rounded-2xl border border-base-content/10 bg-base-300 leading-6 focus:border-primary/60 focus:outline-none"
              placeholder="Your answer, sealed until both are in"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
            />
            <div className="mt-2 flex items-center gap-2">
              {/* No hint about whether they have answered yet. The policy will
                  not tell this client, and inventing a guess here would leak
                  the ordering the whole feature exists to remove. */}
              <p className="flex-1 text-xs text-base-content/50">
                Cannot be edited once sent.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm gap-1.5"
                disabled={busy || draft.trim().length === 0}
                onClick={() => {
                  onAnswer(msg.id, draft.trim());
                  setDraft('');
                }}
              >
                {busy ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                Seal and answer
              </button>
            </div>
          </div>
        )}

        {state === 'awaiting_peer' && (
          <div className="mt-3 space-y-2">
            <Answer label="Yours" text={mine?.text ?? null} sealed />
            <div className="flex items-center gap-2">
              <p className="flex-1 text-xs text-base-content/50">
                Waiting for {peerLabel}. Both answers open at the same moment.
              </p>
              {isOwn && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs gap-1.5 text-base-content/60"
                  onClick={() => onCancel(msg)}
                  disabled={busy}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Withdraw
                </button>
              )}
            </div>
          </div>
        )}

        {state === 'revealed' && (
          <div className="mt-3 space-y-2">
            <Answer label="Yours" text={mine?.text ?? null} />
            <Answer label={peerLabel} text={theirs?.text ?? null} />
          </div>
        )}
      </div>
    </div>
  );
}

/** One side's answer. `sealed` styles the asker's own while it waits — it is
 *  readable to them (they wrote it) but has not been released to anyone. */
function Answer({ label, text, sealed }: { label: string; text: string | null; sealed?: boolean }) {
  return (
    <div
      className={`rounded-xl px-3 py-2 ${
        sealed ? 'bg-base-200/70 ring-1 ring-dashed ring-base-content/15' : 'bg-base-200'
      }`}
    >
      <p className="mb-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-base-content/50">
        {label}
      </p>
      {text === null ? (
        <p className="flex items-center gap-1.5 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Could not be opened on this device.
        </p>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{text}</p>
      )}
    </div>
  );
}
