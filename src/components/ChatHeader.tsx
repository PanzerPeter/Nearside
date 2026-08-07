import { Profile } from '../lib/types';
import type { VerificationState } from '../lib/verification';
import type { PresenceStatus } from '../hooks/usePresence';
import { Avatar } from './Avatar';
import { StatusDot, presenceLabels } from './StatusDot';
import { formatLastSeen } from '../lib/time';
import { ArrowLeft, Image as ImageIcon, NotebookPen, Search, ShieldAlert, ShieldCheck } from 'lucide-react';

interface ChatHeaderProps {
  friend: Profile;
  /** How to name the other participant — a nickname if one is set,
   *  `@display_name` otherwise. */
  peerLabel: string;
  /** The nickname itself, shown alongside the real handle when one is set. */
  nickname: string | null;
  isSelf: boolean;
  trust: VerificationState;
  /** Null when the peer has published no key; there is nothing to compare, so
   *  the verify button has nothing to open. */
  peerKey: Uint8Array | null;
  friendStatus: PresenceStatus;
  friendTyping: boolean;
  searchOpen: boolean;
  onBack: () => void;
  onOpenNickname: () => void;
  onToggleSearch: () => void;
  onOpenVerify: () => void;
  onOpenBackground: () => void;
}

export function ChatHeader({
  friend,
  peerLabel,
  nickname,
  isSelf,
  trust,
  peerKey,
  friendStatus,
  friendTyping,
  searchOpen,
  onBack,
  onOpenNickname,
  onToggleSearch,
  onOpenVerify,
  onOpenBackground,
}: ChatHeaderProps) {
  return (
    <header className="flex items-center gap-3 px-4 sm:px-5 py-3 bg-base-100 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.25)] z-10 shrink-0">
      <button
        className="btn btn-ghost btn-sm btn-square lg:hidden hover:bg-base-content/10 transition-colors"
        onClick={onBack}
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <div className="relative shrink-0" style={{ width: 36, height: 36 }}>
        <Avatar display_name={friend.display_name} url={friend.avatar_url} size={36} />
        {isSelf && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
            <NotebookPen className="w-3 h-3 text-primary" />
          </span>
        )}
      </div>
      {/* The name is the button that opens the nickname editor: it is the
          thing being renamed, so it needs no icon of its own to explain it. */}
      <button
        type="button"
        className="min-w-0 text-left rounded-lg px-1 -mx-1 hover:bg-base-content/5 transition-colors"
        onClick={onOpenNickname}
        title={isSelf ? 'Name this chat' : 'Set a nickname'}
      >
        <p className="font-semibold text-sm truncate flex items-center gap-1.5">
          <span className="truncate">{peerLabel}</span>
          {/* Verification as visible state, not as a coloured icon in the
              corner someone has to know to look at. A contact you took the
              trouble to verify should look verified from across the room. */}
          {trust === 'verified' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-success"
              title="You compared safety numbers with this contact"
            >
              <ShieldCheck className="w-3 h-3" />
              Verified
            </span>
          )}
          {trust === 'changed' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-error/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-error"
              title="Their key is not the one you verified"
            >
              <ShieldAlert className="w-3 h-3" />
              Key changed
            </span>
          )}
          {nickname && !isSelf && (
            <span className="shrink-0 font-normal text-xs text-base-content/60">
              @{friend.display_name}
            </span>
          )}
        </p>
        <p className="text-xs text-base-content/60">
          {isSelf ? (
            // Presence and last-seen would be this device reporting on
            // itself; what is worth saying here is that nobody else can read
            // any of it.
            <span>Only you can see this</span>
          ) : friendTyping ? (
            <span className="inline-flex items-center gap-1.5 text-primary">
              <span className="loading loading-dots loading-xs" />
              typing
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={friendStatus} size={8} />
              {friendStatus === 'offline' && friend.last_seen_at
                ? formatLastSeen(friend.last_seen_at)
                : presenceLabels[friendStatus]}
            </span>
          )}
        </p>
      </button>
      <button
        className="btn btn-ghost btn-sm btn-square ml-auto hover:bg-base-content/10 transition-colors"
        onClick={onToggleSearch}
        title="Search messages"
        aria-pressed={searchOpen}
      >
        <Search className="w-5 h-5" />
      </button>
      {!isSelf && (
        <button
          className={`btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors ${
            trust === 'changed' ? 'text-error' : trust === 'verified' ? 'text-success' : ''
          }`}
          onClick={onOpenVerify}
          disabled={!peerKey}
          title={
            trust === 'changed'
              ? 'Their key changed'
              : trust === 'verified'
                ? 'Verified'
                : 'Verify safety number'
          }
        >
          {trust === 'verified' ? (
            <ShieldCheck className="w-5 h-5" />
          ) : (
            <ShieldAlert className="w-5 h-5" />
          )}
        </button>
      )}
      <button
        className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
        onClick={onOpenBackground}
        title="Chat background"
      >
        <ImageIcon className="w-5 h-5" />
      </button>
    </header>
  );
}
