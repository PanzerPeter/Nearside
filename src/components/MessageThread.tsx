import { Message, PendingMessage, Reaction } from '../lib/types';
import { pendingAsMessage } from '../lib/message-queries';
import { formatUnread, statusFor, type Receipt } from '../lib/receipts';
import { formatDate, formatTime } from '../lib/time';
import type { ReplyTargets } from '../hooks/useReplyTargets';
import type { ThreadScroll } from '../hooks/useThreadScroll';
import { MessageBubble } from './MessageBubble';
import { ChevronDown } from 'lucide-react';

/** Group consecutive messages from the same sender within this window. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface MessageThreadProps {
  me: string;
  peerLabel: string;
  isSelf: boolean;
  messages: Message[];
  /** Queued sends, newest by construction — rendered after `messages` rather
   *  than merged into them, because a queue entry's client uuid will never
   *  match a real row's id and folding it in would leave a duplicate bubble
   *  once the realtime INSERT lands. */
  queued: PendingMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  peerReceipt: Receipt | null;
  reactions: Map<string, Reaction[]>;
  replyTargets: ReplyTargets;
  scroll: ThreadScroll;
  /** The chat background, if the pair chose one — a decorative layer behind
   *  the thread. */
  backgroundUrl: string | null;
  editingId: string | null;
  editingText: string;
  /** False for a message that was on screen before this conversation's first
   *  paint, which is what keeps opening a chat from cascading the entrance
   *  animation across every message in it. */
  isAlreadySeen: (id: string) => boolean;
  onLoadOlder: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReply: (msg: Message) => void;
  onForward: (msg: Message) => void;
  onJumpToReplied: (target: Message) => void;
  onEditingTextChange: (v: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (msg: Message) => void;
  onDelete: (msg: Message) => void;
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

export function MessageThread({
  me,
  peerLabel,
  isSelf,
  messages,
  queued,
  hasMore,
  loadingOlder,
  peerReceipt,
  reactions,
  replyTargets,
  scroll,
  backgroundUrl,
  editingId,
  editingText,
  isAlreadySeen,
  onLoadOlder,
  onToggleReaction,
  onReply,
  onForward,
  onJumpToReplied,
  onEditingTextChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDelete,
}: MessageThreadProps) {
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
              className="btn btn-ghost btn-xs text-base-content/60"
              onClick={onLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Load older messages'
              )}
            </button>
          </div>
        )}

        {messages.length === 0 && queued.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-6">
              {isSelf ? (
                <>
                  <p className="text-base-content/60 text-sm">
                    Send yourself notes, links and reminders
                  </p>
                  {/* "Your words", not "everything": the text is sealed with
                      the vault key, but an attachment is still an object in
                      Storage that the server can read. Claiming otherwise
                      here would be the app's first lie about the one
                      property it is selling. */}
                  <p className="text-base-content/60 text-xs mt-1">
                    Notes, photos and voice memos. Your words are encrypted with a key only this
                    phone holds.
                  </p>
                </>
              ) : (
                <p className="text-base-content/60 text-sm">
                  Start the conversation with {peerLabel}
                </p>
              )}
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
                className={`rounded-xl transition-shadow duration-300 ${
                  groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'
                } ${scroll.highlightId === msg.id ? 'ring-2 ring-primary' : ''}`}
              >
                {showDateDivider && (
                  <div className="flex justify-center my-4">
                    <span className="text-[0.7rem] font-medium text-base-content/60 bg-base-300/80 px-3 py-1 rounded-full ring-1 ring-base-content/5 backdrop-blur-sm">
                      {msgDate}
                    </span>
                  </div>
                )}
                <MessageBubble
                  msg={msg}
                  isOwn={isOwn}
                  me={me}
                  peerLabel={peerLabel}
                  showHeader={!groupedWithPrev}
                  isEditing={editingId === msg.id}
                  editingText={editingText}
                  reactions={reactions.get(msg.id) ?? []}
                  repliedTo={msg.reply_to_id ? replyTargets.get(msg.reply_to_id) : null}
                  repliedToLoading={
                    msg.reply_to_id ? replyTargets.isLoading(msg.reply_to_id) : false
                  }
                  onForward={onForward}
                  onJumpToReplied={onJumpToReplied}
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
              </div>
            );
          })}

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
                className={`opacity-90 ${groupedWithPrev ? 'mt-0.5' : 'mt-3 first:mt-0'}`}
              >
                <MessageBubble
                  msg={pendingAsMessage(msg)}
                  isOwn
                  me={me}
                  peerLabel={peerLabel}
                  showHeader={!groupedWithPrev}
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
              </div>
            );
          })}
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
              ? `Jump to latest messages, ${scroll.newSinceScroll} new`
              : 'Jump to latest messages'
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
