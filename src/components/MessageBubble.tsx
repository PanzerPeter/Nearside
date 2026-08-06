import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Message, Reaction } from '../lib/types';
import { MediaAttachment } from './MediaAttachment';
import { VoiceNote } from './VoiceNote';
import { MessageText } from './MessageText';
import { MAX_TEXTAREA_PX } from './Composer';
import { MessageMenu, type MessageMenuAction } from './MessageMenu';
import { ReactionChips } from './ReactionChips';
import { useSwipeToReply } from '../hooks/useSwipeToReply';
import { useToast } from '../hooks/useToast';
import { MAX_MESSAGE_LENGTH, messageSnippet } from '../lib/conversation';
import { isForwardable } from '../lib/forward';
import { isCoarsePointer } from '../lib/device';
import type { MessageStatusKind } from '../lib/receipts';
import { MessageStatus } from './MessageStatus';
import { Copy, CornerUpRight, MoreVertical, Pencil, Trash2, Check, X, Reply } from 'lucide-react';

interface MessageBubbleProps {
  msg: Message;
  isOwn: boolean;
  me: string;
  /** How to name the other participant — a nickname if one is set,
   *  `@username` otherwise. Formatted by the caller. */
  peerLabel: string;
  showHeader: boolean;
  isEditing: boolean;
  editingText: string;
  reactions: Reaction[];
  /** The message this one quotes, once resolved — it can live outside the
   *  loaded window, so the parent resolves it rather than the bubble. */
  repliedTo: Message | null;
  /** True while `repliedTo` is still being looked up, so the quote can wait
   *  instead of announcing a message that is merely not here yet as gone. */
  repliedToLoading?: boolean;
  /** Lifecycle glyph for own messages; omitted for the friend's. */
  status?: MessageStatusKind;
  /** True only for a message that arrived after this conversation's first
   *  paint — gates the entrance animation so opening a chat doesn't cascade
   *  it across every message already there. */
  isNew?: boolean;
  onToggleReaction: (emoji: string) => void;
  onReply: (msg: Message) => void;
  /** Open the picker that passes this message to another conversation.
   *  Omitted where forwarding cannot apply — a queued message has no server
   *  row to copy from. */
  onForward?: (msg: Message) => void;
  /** Follow this reply's quote back to the message it answers. */
  onJumpToReplied: (target: Message) => void;
  onEditingTextChange: (v: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onStartEdit: (msg: Message) => void;
  onDelete: (msg: Message) => void;
  formatTime: (s: string) => string;
}

export function MessageBubble({
  msg,
  isOwn,
  me,
  peerLabel,
  showHeader,
  isEditing,
  editingText,
  reactions,
  repliedTo,
  repliedToLoading,
  status,
  isNew,
  onToggleReaction,
  onReply,
  onForward,
  onJumpToReplied,
  onEditingTextChange,
  onSaveEdit,
  onCancelEdit,
  onStartEdit,
  onDelete,
  formatTime,
}: MessageBubbleProps) {
  const isDeleted = !!msg.deleted_at;
  const [menuOpen, setMenuOpen] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const hasReactions = reactions.length > 0;
  // A queued message has no server row yet, so nothing can be done to it.
  const hasMenu = !isDeleted && status !== 'pending';
  // Toasting a copy result is a leaf concern with nothing to do with this
  // conversation's state — every other component in the app (ChatRoom
  // included) reaches `useToast()` directly rather than threading it through
  // props, so copy follows that precedent instead of widening the props list.
  const toast = useToast();

  async function copyContent() {
    if (!msg.content) return;
    try {
      await navigator.clipboard.writeText(msg.content);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy.');
    }
  }

  // Editing replaces the bubble with a textarea, and a menu anchored to an
  // element that no longer exists has nothing to attach to.
  useEffect(() => {
    if (isEditing || isDeleted) setMenuOpen(false);
  }, [isEditing, isDeleted]);

  const actions: MessageMenuAction[] = [
    {
      key: 'reply',
      label: 'Reply',
      icon: <Reply className="w-4 h-4" />,
      onSelect: () => onReply(msg),
    },
    // Either side's messages can be forwarded — the point of the action is to
    // pass on something you received as much as something you wrote. Absent
    // when there is nothing to carry across (see `isForwardable`).
    ...(onForward && isForwardable(msg)
      ? [
          {
            key: 'forward',
            label: 'Forward',
            icon: <CornerUpRight className="w-4 h-4" />,
            onSelect: () => onForward(msg),
          },
        ]
      : []),
    ...(msg.content
      ? [
          {
            key: 'copy',
            label: 'Copy',
            icon: <Copy className="w-4 h-4" />,
            onSelect: () => void copyContent(),
          },
        ]
      : []),
    // Edit and delete stay own-only: you can't change a message you didn't
    // send. Media has no editable body — the caption travels with the file.
    ...(isOwn && msg.content && !msg.media_path
      ? [
          {
            key: 'edit',
            label: 'Edit',
            icon: <Pencil className="w-4 h-4" />,
            onSelect: () => onStartEdit(msg),
          },
        ]
      : []),
    ...(isOwn
      ? [
          {
            key: 'delete',
            label: 'Delete',
            icon: <Trash2 className="w-4 h-4" />,
            onSelect: () => onDelete(msg),
            danger: true,
          },
        ]
      : []),
  ];

  // Auto-grow the edit textarea, same reset-then-measure approach as
  // Composer's own — ref is null while not editing, so this is a no-op then.
  useLayoutEffect(() => {
    const el = editTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
    // isEditing is a dep, not just editingText: cancelling leaves editingText
    // untouched, so re-editing the same message sets an identical string,
    // React bails on the update, and the remounted textarea would keep its
    // one-row height with the content scrolling inside it.
  }, [editingText, isEditing]);

  // Gesture reply: swipe (touch) or double-click (desktop). Own messages can
  // be replied to too now — the menu already offered it, this just brings
  // swipe/double-click into agreement. A pending message has no server row
  // yet, so a reply built against its id would point `reply_to_id` at
  // something the server has never seen; excluded the same way the toolbar
  // and dropdown below already are.
  const canReply = !isDeleted && !isEditing && status !== 'pending';
  // Friend's messages sit on the left and swipe right; own messages sit on
  // the right and swipe left — both swipe away from their anchored edge.
  const direction = isOwn ? -1 : 1;
  const { offset, armed, swiping, consumeSwipeClick, handlers } = useSwipeToReply({
    enabled: canReply,
    onReply: () => onReply(msg),
    direction,
  });

  return (
    <div
      className={`group flex flex-col ${isOwn ? 'items-end' : 'items-start'} ${
        isNew ? 'animate-message-in' : ''
      }`}
    >
      {/* Alignment alone already says who spoke in a two-person DM; the
          friend's name is still worth one anchor per group, but own messages
          need no label at all — time and status now live in the bubble's
          own footer below. */}
      {!isOwn && showHeader && (
        <div className="text-xs text-base-content/60 mb-0.5 px-1">{peerLabel}</div>
      )}

      {isEditing ? (
        // items-end, not items-center: once the textarea grows past one line
        // the save/cancel buttons should sit at its bottom edge, by the
        // caret's usual resting place, not float centred against its height.
        <div className={`flex items-end gap-1.5 ${isOwn ? 'flex-row-reverse' : ''}`}>
          <textarea
            ref={editTextareaRef}
            rows={1}
            className="textarea textarea-bordered textarea-sm text-base bg-base-100 w-full max-w-[85%] sm:max-w-md resize-none min-h-0 leading-6 py-1.5"
            value={editingText}
            onChange={(e) => onEditingTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSaveEdit(msg.id);
              }
              if (e.key === 'Escape') onCancelEdit();
            }}
            maxLength={MAX_MESSAGE_LENGTH}
            autoFocus
          />
          <button className="btn btn-success btn-xs btn-circle" onClick={() => onSaveEdit(msg.id)}>
            <Check className="w-3 h-3" />
          </button>
          <button className="btn btn-ghost btn-xs btn-circle" onClick={onCancelEdit}>
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        // w-fit lets the bubble hug short text (no vertical "H e y"), while
        // max-w caps long messages so they wrap at a comfortable width. The
        // relative wrapper hugs the bubble so overlays anchor to its edges.
        <div className="relative w-fit max-w-[85%] sm:max-w-[70%]">
          {/* Reply cue that sits in the gap opening up as you swipe the bubble
              toward its own edge; snaps to the primary colour once past the
              trigger. Anchored to the same side the bubble swipes away from —
              left for the friend's messages, right for your own. */}
          {canReply && swiping && (
            <div
              className={`absolute inset-y-0 flex items-center justify-center overflow-hidden ${
                isOwn ? 'right-0' : 'left-0'
              }`}
              style={{ width: offset }}
              aria-hidden
            >
              <span
                className={`flex items-center justify-center w-7 h-7 rounded-full transition-colors ${
                  armed
                    ? 'bg-primary text-primary-content'
                    : 'bg-base-300 text-base-content/60'
                }`}
                style={{
                  opacity: Math.min(1, offset / 40),
                  transform: `scale(${armed ? 1.1 : Math.min(1, 0.7 + offset / 120)})`,
                }}
              >
                <Reply className="w-4 h-4" />
              </span>
            </div>
          )}
          <div
            ref={bubbleRef}
            {...(canReply ? handlers : {})}
            onClick={(e) => {
              // A completed swipe fires a trailing click; swallow it so it
              // doesn't also open the menu.
              if (consumeSwipeClick()) return;
              // Don't steal a text-selection gesture (mostly desktop).
              if (window.getSelection()?.toString()) return;
              // Controls inside the bubble — a voice note's play button, a
              // link, an attachment — own their taps. Opening the menu on top
              // of the thing you just pressed is not what you asked for.
              if ((e.target as HTMLElement).closest('button, a, audio, video')) return;
              // Tapping the message *is* the gesture on touch, where there is
              // no hover to reveal the handle beside it. On a pointer device
              // a plain click stays inert — the handle and right-click are
              // the ways in, so clicking a message never interrupts reading.
              if (!hasMenu || !isCoarsePointer()) return;
              setMenuOpen((open) => !open);
            }}
            onContextMenu={
              hasMenu
                ? (e) => {
                    e.preventDefault();
                    setMenuOpen(true);
                  }
                : undefined
            }
            onDoubleClick={canReply ? () => onReply(msg) : undefined}
            style={{
              transform: offset ? `translateX(${offset * direction}px)` : undefined,
              transition: swiping ? 'none' : 'transform 0.2s ease-out',
              touchAction: canReply ? 'pan-y' : undefined,
            }}
            className={`px-3.5 pt-2 rounded-2xl whitespace-pre-wrap break-words shadow-[0_1px_2px_rgba(0,0,0,0.28)] cursor-default ${
              isOwn ? 'rounded-br-md' : 'rounded-bl-md'
            } ${
              // Reaction chips hang ~12px up into the bubble from -bottom-2.5.
              // Without extra bottom padding they land on the footer, which is
              // right-aligned like the friend's chips and like a short own
              // bubble the footer itself sizes. The pad keeps them over dead
              // space instead of over the timestamp.
              !isDeleted && hasReactions ? 'pb-5' : 'pb-2'
            } ${
              isDeleted
                ? 'bg-base-300/60 text-base-content/60 italic'
                : isOwn
                ? 'bg-primary text-primary-content'
                : 'bg-neutral text-neutral-content'
            } ${
              // The menu is a floating card that can end up above or below its
              // bubble; the ring is what keeps it visibly attached to the
              // message it acts on.
              menuOpen ? 'ring-2 ring-primary/60' : ''
            }`}
          >
            {isDeleted ? (
              'This message was deleted'
            ) : (
              <div className="space-y-1.5">
                {/* Says how the message got here, not where it came from —
                    naming the original sender would disclose a conversation
                    this reader is not part of. See migration 0018. */}
                {msg.forwarded && (
                  <p className="flex items-center gap-1 text-xs italic opacity-70">
                    <CornerUpRight className="w-3 h-3 shrink-0" aria-hidden />
                    Forwarded
                  </p>
                )}
                {msg.reply_to_id && (
                  // A button, not a div: following a quote back to what it
                  // answers is the whole point of a quote, and it has to be
                  // reachable by keyboard as well as by tap. `stopPropagation`
                  // keeps the tap from also toggling this bubble's own menu.
                  // Disabled while the quoted message is still being fetched
                  // and when it can't be read at all — there is nowhere to go.
                  <button
                    type="button"
                    disabled={!repliedTo}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (repliedTo) onJumpToReplied(repliedTo);
                    }}
                    className="block w-full text-left pl-2 border-l-2 border-primary/50 text-xs opacity-70 rounded-r enabled:hover:opacity-100 enabled:cursor-pointer transition-opacity"
                  >
                    {/* Whose message is being quoted — judged against the
                        viewer, not against the author of the reply. */}
                    <span className="font-medium">
                      {repliedTo ? (repliedTo.user_id === me ? 'You' : peerLabel) : ''}
                    </span>
                    <span className="ml-1 line-clamp-2">
                      {repliedTo
                        ? messageSnippet(repliedTo)
                        : repliedToLoading
                          ? '…'
                          : 'Message unavailable'}
                    </span>
                  </button>
                )}
                {msg.media_path &&
                  msg.media_type &&
                  (msg.media_type === 'audio' ? (
                    <VoiceNote path={msg.media_path} durationMs={msg.media_duration_ms} />
                  ) : (
                    <MediaAttachment path={msg.media_path} type={msg.media_type} />
                  ))}
                {msg.content && <MessageText text={msg.content} />}
                {/* Sealed, and this device could not open it — most likely a
                    vault written under a key this phone was never given. Said
                    out loud, because an empty bubble would read as a message
                    someone actually sent as empty. */}
                {msg.decrypt_failed && (
                  <p className="text-sm italic opacity-70">Can't decrypt this message</p>
                )}
              </div>
            )}

            {/* In-bubble footer: replaces the old per-group metadata row and
                the separate compact status row that used to sit beneath a
                grouped own-message bubble. No explicit text colour here —
                it inherits from the bubble (text-primary-content for own,
                text-neutral-content for the friend's, text-base-content/60
                when deleted), which is what keeps it legible on all three. */}
            {/* opacity-75 would compound with the deleted bubble's inherited
                text-base-content/60 down to ~0.45 alpha, below the /55 floor —
                so the dim comes only from the bubble there. It sits on the
                individual items rather than this row so MessageStatus can opt
                out of it for a "read" tick; a parent opacity would clamp the
                child no matter what the child asks for. */}
            <div className="text-[0.65rem] leading-none flex items-center gap-1 justify-end mt-1 -mb-0.5">
              <time className={isDeleted ? '' : 'opacity-75'}>{formatTime(msg.created_at)}</time>
              {msg.edited_at && !isDeleted && <span className="opacity-75">(edited)</span>}
              {isOwn && status && !isDeleted && <MessageStatus status={status} />}
            </div>
          </div>

          {/* Reactions straddle the inner-bottom corner of the bubble:
              bottom-left for your own messages, bottom-right for the friend's. */}
          {!isDeleted && hasReactions && (
            <div
              className={`absolute -bottom-2.5 z-10 ${isOwn ? 'left-2' : 'right-2'}`}
            >
              <ReactionChips reactions={reactions} me={me} onToggle={onToggleReaction} />
            </div>
          )}

          {/* One trigger, one menu. A pending message doesn't exist
              server-side yet: every action would be a no-op, so it offers
              none at all rather than controls that silently do nothing. */}
          {hasMenu && (
            <>
              {/* Pointer devices get a discreet handle on hover (at every
                  width — a narrow desktop window has a mouse too, and gating
                  this on `lg` left it with no way in but right-click); touch
                  opens the menu by tapping the bubble itself. */}
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="Message actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={`btn btn-ghost btn-xs btn-circle absolute top-1 ${
                  isOwn ? 'right-full mr-1' : 'left-full ml-1'
                } ${
                  menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
                } group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity`}
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>

              <MessageMenu
                open={menuOpen}
                anchorRef={bubbleRef}
                align={isOwn ? 'end' : 'start'}
                actions={actions}
                onReact={onToggleReaction}
                onClose={() => setMenuOpen(false)}
              />
            </>
          )}
        </div>
      )}

      {/* Reserve space so the corner-anchored reactions don't overlap the next row. */}
      {!isDeleted && !isEditing && hasReactions && <div className="h-3" aria-hidden />}
    </div>
  );
}
