import { Avatar } from './Avatar';
import { AvatarWithStatus } from './AvatarWithStatus';
import { formatListTime } from '../lib/time';
import { formatUnread } from '../lib/receipts';
import { isSelfChat } from '../lib/conversation';
import { formatDisplayName, useNickname } from '../lib/nicknames';
import type { ConversationSummary, MediaType } from '../lib/types';
import { Ban, BellOff, NotebookPen, Pin } from 'lucide-react';
import { peekDraft } from '../lib/drafts';
import { useT } from '../hooks/useT';

interface ConversationRowProps {
  conversation: ConversationSummary;
  me: string;
  unread: number;
  selected: boolean;
  onSelect: () => void;
  /** The last message's text, from the local mirror. Null when this device has
   *  never opened that message — the server no longer has a body to offer, so
   *  there is nothing to fall back to and the row says so. */
  lastText: string | null;
  /** This device's flags for the conversation. Both get a mark, because
   *  otherwise "why is this at the top" and "why is this silent" have no
   *  answer on the screen showing them. */
  pinned?: boolean;
  muted?: boolean;
  /** Marked unread by hand, with no server count behind it. Drawn as a dot
   *  rather than a number, because inventing "1" would be the app claiming a
   *  message that does not exist. */
  markedUnread?: boolean;
  /** Either side has blocked. The row stays — the history is still there to
   *  read — and says so, in place of the preview. */
  blocked?: boolean;
}

/** One line of the sidebar: who, what they last said, when, and how many unread. */
export function ConversationRow({
  conversation,
  me,
  unread,
  selected,
  onSelect,
  lastText,
  pinned = false,
  muted = false,
  markedUnread = false,
  blocked = false,
}: ConversationRowProps) {
  const t = useT();
  const { display_name, avatar_url, last_media_type, last_sender_id, last_at } = conversation;
  const isSelf = isSelfChat(me, conversation.peer_id);
  const nickname = useNickname(conversation.peer_id);
  // The nickname is the name; the handle moves to a muted suffix so it is still
  // visible (you have to be able to tell two people apart by something they did
  // not choose for each other) without being the thing you read first.
  const title = formatDisplayName(nickname, display_name, isSelf);
  const handle = nickname && !isSelf ? `@${display_name}` : null;

  const mediaLabels: Record<MediaType, string> = {
    image: t('preview.photo'),
    video: t('preview.video'),
    audio: t('preview.voice'),
    sticker: t('preview.sticker'),
  };
  // Unsent text beats the last message in the preview, the way it does in every
  // other messenger: a draft is the thing you have not finished, and drafts here
  // live only in memory, so a forgotten one is a lost one. Suppressed on the
  // conversation that is open — the text is already on screen in the composer,
  // and repeating it in the row beside it is noise.
  const draft = selected ? '' : peekDraft('peer', conversation.peer_id).trim();
  const body = lastText?.trim() || (last_media_type ? mediaLabels[last_media_type] : '');
  // "You:" on a note to yourself would be noise — every message there is yours.
  const preview = body
    ? last_sender_id === me && !isSelf
      ? t('preview.fromYou', { body })
      : body
    : // There IS a message here (the server gave us its timestamp) but this
      // device has never opened it, so no plaintext exists to preview. Saying
      // so beats a blank row that reads as broken — and it is the product
      // working, not failing.
      last_at
      ? t('preview.encrypted')
      : isSelf
        ? t('preview.selfEmpty')
        : t('preview.none');

  return (
    <button
      className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-field transition-colors ${
        selected ? 'bg-primary/10 text-base-content' : 'hover:bg-wash text-base-content'
      }`}
      onClick={onSelect}
    >
      {selected && (
        <span className="brand-gradient absolute left-0 top-1/2 -translate-y-1/2 h-7 w-1 rounded-r-full" />
      )}
      {/* No presence dot on your own row: it would report your own device back
          to you, and the notebook mark is what makes the row recognisable. */}
      {isSelf ? (
        <div className="relative shrink-0" style={{ width: 40, height: 40 }}>
          <Avatar display_name={display_name} url={avatar_url} size={40} />
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
            <NotebookPen className="w-3 h-3 text-primary" />
          </span>
        </div>
      ) : (
        <AvatarWithStatus
          userId={conversation.peer_id}
          display_name={display_name}
          url={avatar_url}
          size={40}
        />
      )}
      <span className="flex-1 min-w-0 text-left">
        <span className="flex items-baseline gap-2">
          <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
            <span
              className={`truncate text-body ${
                unread > 0 || markedUnread ? 'font-semibold' : 'font-medium'
              }`}
            >
              {title}
            </span>
            {handle && (
              <span className="min-w-0 truncate text-micro text-subtle">{handle}</span>
            )}
          </span>
          {blocked && (
            <Ban className="shrink-0 w-3 h-3 text-subtle" aria-label={t('chat.blocked')} />
          )}
          {muted && (
            <BellOff
              className="shrink-0 w-3 h-3 text-subtle"
              aria-label={t('chatList.muted')}
            />
          )}
          {pinned && (
            <Pin className="shrink-0 w-3 h-3 text-subtle" aria-label={t('chatList.pinned')} />
          )}
          {last_at && (
            <span className="shrink-0 text-micro text-subtle">
              {formatListTime(last_at)}
            </span>
          )}
        </span>
        <span
          className={`block truncate text-meta ${
            draft ? 'text-muted' : unread > 0 ? 'text-strong font-medium' : 'text-muted'
          }`}
        >
          {blocked ? (
            t('chat.blocked')
          ) : (
            <>
              {draft && (
                <span className="text-error font-medium">{t('preview.draftLabel')} </span>
              )}
              {draft ? draft : preview}
            </>
          )}
        </span>
      </span>
      {unread > 0 ? (
        <span
          className="shrink-0 min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-content text-micro font-bold leading-none"
          aria-label={t('chatList.unread', { count: unread })}
        >
          {formatUnread(unread)}
        </span>
      ) : markedUnread ? (
        <span
          className="shrink-0 w-2.5 h-2.5 rounded-full bg-primary"
          aria-label={t('chatList.markedUnread')}
        />
      ) : null}
    </button>
  );
}
