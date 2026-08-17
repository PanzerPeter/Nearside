import { Avatar } from './Avatar';
import { AvatarWithStatus } from './AvatarWithStatus';
import { formatListTime } from '../lib/time';
import { formatUnread } from '../lib/receipts';
import { isSelfChat } from '../lib/conversation';
import { formatDisplayName, useNickname } from '../lib/nicknames';
import type { ConversationSummary, MediaType } from '../lib/types';
import { BellOff, NotebookPen, Pin } from 'lucide-react';
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
      className={`relative w-full flex items-center gap-3 px-2 py-2.5 rounded-xl transition-colors ${
        selected ? 'bg-primary/15 text-primary' : 'hover:bg-base-content/5 text-base-content'
      }`}
      onClick={onSelect}
    >
      {selected && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-primary" />
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
            <span className={`truncate text-sm ${unread > 0 ? 'font-semibold' : 'font-medium'}`}>
              {title}
            </span>
            {handle && (
              <span className="min-w-0 truncate text-[0.7rem] text-base-content/60">{handle}</span>
            )}
          </span>
          {muted && (
            <BellOff
              className="shrink-0 w-3 h-3 text-base-content/45"
              aria-label={t('chatList.muted')}
            />
          )}
          {pinned && (
            <Pin className="shrink-0 w-3 h-3 text-base-content/45" aria-label={t('chatList.pinned')} />
          )}
          {last_at && (
            <span className="shrink-0 text-[0.7rem] text-base-content/55">
              {formatListTime(last_at)}
            </span>
          )}
        </span>
        <span
          className={`block truncate text-xs ${
            unread > 0 ? 'text-base-content/80 font-medium' : 'text-base-content/55'
          }`}
        >
          {preview}
        </span>
      </span>
      {unread > 0 && (
        <span
          className="shrink-0 min-w-[1.25rem] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-content text-[0.7rem] font-bold leading-none"
          aria-label={t('chatList.unread', { count: unread })}
        >
          {formatUnread(unread)}
        </span>
      )}
    </button>
  );
}
