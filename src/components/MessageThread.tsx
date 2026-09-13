import { Message, PendingMessage, Reaction } from '../lib/types';
import { pendingAsMessage } from '../lib/message-queries';
import { formatUnread, statusFor, type Receipt } from '../lib/receipts';
import { formatDate, formatTime } from '../lib/time';
import { timerChangeIndex, type TimerChange } from '../lib/disappearing';
import type { ReplyTargets } from '../hooks/useReplyTargets';
import type { ThreadScroll } from '../hooks/useThreadScroll';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { SealedExchange } from './SealedExchange';
import type { OpenedAnswer } from '../lib/sealed-exchange';
import { AlertCircle, ChevronDown, Timer } from 'lucide-react';
import { useT } from '../hooks/useT';

/** Group consecutive messages from the same sender within this window. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface MessageThreadProps {
  me: string;
  /** How to name the other participant, for the empty state and the typing
   *  line. In a room, the group's own name is not what either of those want,
   *  so a room passes a label and supplies `emptyState` and `typingLabel`
   *  itself. */
  peerLabel: string;
  /** How to name whoever wrote a given message. A 1:1 thread passes a function
   *  that ignores its argument; a room looks the member up. */
  nameFor: (userId: string) => string;
  /** Print the author's name above each run of messages. True in a room, where
   *  a message that doesn't say who wrote it is worse than one in a box; false
   *  in a 1:1, where the bubble's side already answers it. Also decides
   *  whether the typing line names names. */
  showSenderNames: boolean;
  /** Text colour class per author, so a group's members stay tellable apart
   *  (`roomColour`). Unused in a 1:1. */
  colourFor?: (userId: string) => string | undefined;
  /** Display names present in this conversation, for `@name` — see
   *  `lib/mentions.ts`. Rooms pass their member list. */
  handles?: string[];
  /** My own display name, so a mention of me reads louder. */
  myHandle?: string;
  /** Stands in for the default "start the conversation" block. A room's is a
   *  different sentence about a different thing. */
  emptyState?: React.ReactNode;
  isSelf: boolean;
  /** Rendered as given — `ChatRoom` has already put back the media columns of
   *  any row the sender trimmed and this device pinned. */
  messages: readonly Message[];
  /** Queued sends, newest by construction — rendered after `messages` rather
   *  than merged into them, because a queue entry's client uuid will never
   *  match a real row's id and folding it in would leave a duplicate bubble
   *  once the realtime INSERT lands. */
  queued: PendingMessage[];
  /** The sentence to show while somebody is typing, already composed by the
   *  caller — a room has to name names ("Anna and Bo are typing") and a 1:1
   *  does not. Null when nobody is, and in the self-chat, where the only
   *  person typing is you. */
  typingLabel: string | null;
  hasMore: boolean;
  loadingOlder: boolean;
  /** Null in a room: every member has their own watermark, and a single tick
   *  meaning "the server has this row" is the most a group bubble can honestly
   *  claim. `statusFor` returns exactly that for a null receipt. */
  peerReceipt: Receipt | null;
  /** The message the "new messages" line sits above, or null when there is
   *  nothing the reader missed. */
  unreadDividerId: string | null;
  reactions: Map<string, Reaction[]>;
  replyTargets: ReplyTargets;
  scroll: ThreadScroll;
  /** The chat background, if the pair chose one — a decorative layer behind
   *  the thread. */
  backgroundUrl: string | null;
  /** The conversation's timer as a line in the thread, or null when the pair
   *  has never set one. */
  timerChange: TimerChange | null;
  editingId: string | null;
  editingText: string;
  /** Answers to the sealed questions in this thread, by prompt id — only the
   *  ones the server has released to this account. Absent in a room: the
   *  policy that makes the feature work is written over a pair of people. */
  sealedAnswers?: Map<string, OpenedAnswer[]>;
  /** Prompt ids with a write in flight. */
  sealedBusy?: Set<string>;
  onAnswerSealed?: (promptId: string, text: string) => void;
  /** False for a message that was on screen before this conversation's first
   *  paint, which is what keeps opening a chat from cascading the entrance
   *  animation across every message in it. */
  isAlreadySeen: (id: string) => boolean;
  onLoadOlder: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReply: (msg: Message) => void;
  onForward: (msg: Message) => void;
  /** Open the sheet listing who reacted to this message. */
  onShowReactions: (msg: Message) => void;
  onJumpToReplied: (target: Message) => void;
  /** Picking several messages out at once — see `lib/selection.ts`. */
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onStartSelecting: (msg: Message) => void;
  onToggleSelected: (msg: Message) => void;
  /** The message held at the top of this conversation, so its own bubble can
   *  offer "unpin" rather than "pin". Null when nothing is pinned. */
  pinnedId: string | null;
  onTogglePin: (msg: Message) => void;
  onEditingTextChange: (v: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (msg: Message) => void;
  onDelete: (msg: Message) => void;
  /** Give a queued message that ran out of attempts another go. */
  onRetryQueued: (id: string) => void;
  /** Throw a failed queued message away — the one path that deletes an unsent
   *  body, and it is the user asking for it. */
  onDiscardQueued: (id: string) => void;
}

/** True when `msg` should sit tight under `prev` rather than start its own
 *  block: same sender, same day, within the grouping window. */
function isGrouped(msg: Message | PendingMessage, prev: Message | PendingMessage | undefined) {
  return (
    !!prev &&
    prev.user_id === msg.user_id &&
    new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS
  );
}

/** The timer change, in the middle of the thread where it happened — the same
 *  pill the date divider uses, because it is the same kind of thing: not
 *  something either of you said, but something that happened to the
 *  conversation. */
function TimerNotice({ label }: { label: string }) {
  return (
    <div className="flex justify-center my-4">
      <span className="inline-flex items-center gap-1.5 text-micro font-medium text-muted bg-base-300/80 px-3 py-1 rounded-full ring-1 ring-base-content/5 backdrop-blur-xs">
        <Timer className="w-3 h-3 shrink-0" />
        {label}
      </span>
    </div>
  );
}

export function MessageThread({
  me,
  peerLabel,
  nameFor,
  showSenderNames,
  colourFor,
  handles,
  myHandle,
  emptyState,
  isSelf,
  messages,
  queued,
  typingLabel,
  hasMore,
  loadingOlder,
  peerReceipt,
  unreadDividerId,
  reactions,
  replyTargets,
  scroll,
  backgroundUrl,
  timerChange,
  editingId,
  editingText,
  sealedAnswers,
  sealedBusy,
  onAnswerSealed,
  isAlreadySeen,
  onLoadOlder,
  onToggleReaction,
  onReply,
  onForward,
  onShowReactions,
  onJumpToReplied,
  selecting,
  selectedIds,
  onStartSelecting,
  onToggleSelected,
  pinnedId,
  onTogglePin,
  onEditingTextChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDelete,
  onRetryQueued,
  onDiscardQueued,
}: MessageThreadProps) {
  const t = useT();
  const noticeIndex = timerChange
    ? timerChangeIndex(
        messages.map((m) => m.created_at),
        timerChange.at
      )
    : -1;

  return (
    <div className="relative flex-1 min-h-0">
      {backgroundUrl && (
        <>
          {/* aria-hidden and pointer-events-none: decoration only. Both
              layers sit behind the thread, which is why <main> below is
              positioned — without that it would paint under them. */}
          <div
            aria-hidden
            className="absolute inset-0 bg-cover bg-center pointer-events-none"
            style={{ backgroundImage: `url("${backgroundUrl}")` }}
          />
          {/* Scrim. Bubbles stay opaque, but date dividers, the empty state
              and the load-older button are bare text over whatever photo the
              pair chose — this is what keeps them legible on a light one. */}
          <div aria-hidden className="absolute inset-0 bg-base-200/65 pointer-events-none" />
        </>
      )}
      {/* overflow-x-clip is load-bearing, not defensive: `overflow-y: auto`
          forces the other axis's `visible` to compute to `auto`, so anything
          reaching past the list's right edge — a swipe-to-reply bubble
          travelling up to MAX_PX, a wide bubble's overlay — turned the whole
          thread into a sideways-scrollable pane on touch. `clip` (not
          `hidden`) because hidden would make this a scroll container on both
          axes again, which is what the bug was. */}
      <main
        ref={scroll.listRef}
        onScroll={scroll.handleListScroll}
        className="relative h-full overflow-y-auto overflow-x-clip px-3 sm:px-5 py-4"
      >
        {hasMore && (
          <div className="flex justify-center mb-3">
            <button
              className="btn btn-ghost btn-xs text-muted"
              onClick={onLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                t('thread.loadOlder')
              )}
            </button>
          </div>
        )}

        {messages.length === 0 && queued.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full">
            {/* Inside the empty state rather than after it: the block below is
                a full-height centred box, so a sibling pill would sit under
                the fold of a thread with nothing in it to scroll. */}
            {timerChange && <TimerNotice label={timerChange.label} />}
            <div className="text-center px-6">
              {emptyState ?? (isSelf ? (
                <>
                  <p className="text-muted text-body">{t('thread.selfEmpty')}</p>
                  {/* "Your words", not "everything": the text is sealed with
                      the vault key, but an attachment is still an object in
                      Storage that the server can read. Claiming otherwise
                      here would be the app's first lie about the one
                      property it is selling. */}
                  <p className="text-muted text-meta mt-1">{t('thread.selfEmptyNote')}</p>
                </>
              ) : (
                <p className="text-muted text-body">
                  {t('thread.startWith', { name: peerLabel })}
                </p>
              ))}
            </div>
          </div>
        )}

        <div>
          {messages.map((msg, i) => {
            const isOwn = msg.user_id === me;
            const prev = messages[i - 1];
            const msgDate = formatDate(msg.created_at);
            const showDateDivider = !prev || formatDate(prev.created_at) !== msgDate;
            const groupedWithPrev = !showDateDivider && isGrouped(msg, prev);
            // Not pre-seeded by a fetch means this id reached `messages` via
            // the realtime INSERT handler — the one path an arrival should
            // actually animate for.
            const isNew = !isAlreadySeen(msg.id);

            return (
              <div
                key={msg.id}
                id={`msg-${msg.id}`}
                className={`rounded-box transition-shadow duration-300 ${
                  groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'
                } ${scroll.highlightId === msg.id ? 'ring-2 ring-primary' : ''}`}
              >
                {showDateDivider && (
                  <div className="flex justify-center my-4">
                    <span className="text-micro font-medium text-muted bg-base-300/80 px-3 py-1 rounded-full ring-1 ring-base-content/5 backdrop-blur-xs">
                      {msgDate}
                    </span>
                  </div>
                )}
                {msg.id === unreadDividerId && (
                  // Above the first message they had not seen, not above the
                  // newest: the line answers "where was I", so it has to sit
                  // where reading starts again.
                  <div className="flex items-center gap-2 my-4" aria-hidden={false}>
                    <span className="flex-1 h-px bg-primary/40" />
                    <span className="text-micro font-semibold uppercase tracking-wide text-primary">
                      {t('thread.newMessages')}
                    </span>
                    <span className="flex-1 h-px bg-primary/40" />
                  </div>
                )}
                {timerChange && noticeIndex === i && <TimerNotice label={timerChange.label} />}
                {/* A sealed exchange is a two-sided object with a state, not
                    something one person said, so it takes the whole width
                    instead of hanging off the asker's edge. */}
                {msg.sealed_prompt && onAnswerSealed ? (
                  <SealedExchange
                    msg={msg}
                    me={me}
                    peerLabel={peerLabel}
                    isOwn={isOwn}
                    answers={sealedAnswers?.get(msg.id) ?? []}
                    busy={sealedBusy?.has(msg.id) ?? false}
                    onAnswer={onAnswerSealed}
                    onCancel={onDelete}
                    formatTime={formatTime}
                  />
                ) : (
                <MessageBubble
                  msg={msg}
                  isOwn={isOwn}
                  me={me}
                  nameFor={nameFor}
                  showHeader={showSenderNames && !groupedWithPrev}
                  senderColour={colourFor?.(msg.user_id)}
                  handles={handles}
                  myHandle={myHandle}
                  isEditing={editingId === msg.id}
                  editingText={editingText}
                  reactions={reactions.get(msg.id) ?? []}
                  repliedTo={msg.reply_to_id ? replyTargets.get(msg.reply_to_id) : null}
                  repliedToLoading={
                    msg.reply_to_id ? replyTargets.isLoading(msg.reply_to_id) : false
                  }
                  onForward={onForward}
                  onShowReactions={() => onShowReactions(msg)}
                  onJumpToReplied={onJumpToReplied}
                  onStartSelecting={onStartSelecting}
                  isPinned={pinnedId === msg.id}
                  onTogglePin={onTogglePin}
                  selecting={selecting}
                  selected={selectedIds.has(msg.id)}
                  onToggleSelected={onToggleSelected}
                  status={
                    // No ticks in the self-chat: delivered-to-whom, read-by-whom.
                    isOwn && !isSelf ? statusFor(msg.created_at, peerReceipt) : undefined
                  }
                  isNew={isNew}
                  onToggleReaction={(emoji) => onToggleReaction(msg.id, emoji)}
                  onReply={onReply}
                  onEditingTextChange={onEditingTextChange}
                  onSaveEdit={onSaveEdit}
                  onCancelEdit={onCancelEdit}
                  onStartEdit={onStartEdit}
                  onDelete={onDelete}
                  formatTime={formatTime}
                />
                )}
              </div>
            );
          })}

          {/* The change is newer than everything loaded. Guarded on there being
              something to sit under: with the thread empty the pill is drawn
              inside the empty state above instead, and drawing it twice is the
              bug this excludes. */}
          {timerChange &&
            noticeIndex === messages.length &&
            (messages.length > 0 || queued.length > 0) && (
              <TimerNotice label={timerChange.label} />
            )}

          {/* Every action on a queued send is a no-op: a message that doesn't
              exist server-side can't be edited, deleted, replied to, or
              reacted to. */}
          {queued.map((msg, i) => {
            const prev = i === 0 ? messages[messages.length - 1] : queued[i - 1];
            const groupedWithPrev = isGrouped(msg, prev);

            // opacity-90, not the /70 this started at: the hand-off to the
            // server row is a swap between two elements, so the dim can't
            // tween away — whatever gap is left here is a visible pop the
            // instant a send lands, which for an online send is a few
            // hundred milliseconds after it appears. The clock glyph in the
            // footer is what actually communicates "sending"; this only has
            // to hint at it.
            return (
              <div
                key={msg.id}
                className={`${msg.failed ? 'opacity-100' : 'opacity-90'} ${
                  groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'
                }`}
              >
                <MessageBubble
                  msg={pendingAsMessage(msg)}
                  isOwn
                  me={me}
                  nameFor={nameFor}
                  showHeader={false}
                  isEditing={false}
                  editingText=""
                  reactions={[]}
                  repliedTo={msg.reply_to_id ? replyTargets.get(msg.reply_to_id) : null}
                  repliedToLoading={
                    msg.reply_to_id ? replyTargets.isLoading(msg.reply_to_id) : false
                  }
                  onJumpToReplied={onJumpToReplied}
                  status="pending"
                  // `queued` never carries a first-paint backlog worth
                  // guarding against (it's this session's own in-flight
                  // sends, occasionally a handful recovered from the outbox
                  // on mount) — every entry just appeared, so it always
                  // animates rather than needing the same seen-id tracking
                  // `messages` does.
                  isNew
                  onToggleReaction={() => {}}
                  onReply={() => {}}
                  onEditingTextChange={() => {}}
                  onSaveEdit={() => {}}
                  onCancelEdit={() => {}}
                  onStartEdit={() => {}}
                  onDelete={() => {}}
                  formatTime={formatTime}
                />
                {/* The message ran out of attempts and is still here. It used
                    to be deleted at this point, with a toast the sender only
                    saw if they happened to still be in this conversation — so
                    the words somebody typed were destroyed by the queue whose
                    whole job is to keep them. Nothing is thrown away now
                    without a person asking. */}
                {msg.failed && (
                  <div className="mt-1 flex items-center justify-end gap-2 pr-1 text-micro">
                    <AlertCircle className="w-3 h-3 text-error" aria-hidden />
                    <span className="text-error">{t('outbox.notSent')}</span>
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => onRetryQueued(msg.id)}
                    >
                      {t('outbox.retry')}
                    </button>
                    <button
                      type="button"
                      className="text-subtle hover:underline"
                      onClick={() => onDiscardQueued(msg.id)}
                    >
                      {t('outbox.discard')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Last thing in the thread, above the bottom sentinel: the bubble
              belongs where the message being written will appear, and putting
              it after the sentinel would leave it below the point every
              auto-scroll aims at. */}
          {typingLabel && (
            <TypingIndicator label={typingLabel} showLabel={showSenderNames} />
          )}
        </div>
        <div ref={scroll.bottomRef} />
      </main>

      {!scroll.atBottom && (
        <button
          type="button"
          className="btn btn-circle btn-sm absolute bottom-4 right-4"
          onClick={scroll.scrollToLatest}
          aria-label={
            scroll.newSinceScroll > 0
              ? t('thread.jumpToLatestNew', { count: scroll.newSinceScroll })
              : t('thread.jumpToLatest')
          }
        >
          <ChevronDown className="w-4 h-4" />
          {scroll.newSinceScroll > 0 && (
            <span className="badge badge-primary badge-xs absolute -top-1 -right-1">
              {formatUnread(scroll.newSinceScroll)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
