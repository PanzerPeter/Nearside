import { Profile } from '../lib/types';
import type { VerificationState } from '../lib/verification';
import type { PresenceStatus } from '../hooks/usePresence';
import { Avatar } from './Avatar';
import { StatusDot, presenceLabels } from './StatusDot';
import { formatLastSeen } from '../lib/time';
import {
  ArrowLeft,
  Image as ImageIcon,
  MoreVertical,
  NotebookPen,
  Pencil,
  Search,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { formatTtl, TTL_OPTIONS, type ConversationTimer } from '../lib/disappearing';

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
  /** The conversation's timer, or null when there has never been one. Either
   *  participant may change it; `setBy` is who did last. */
  timer: ConversationTimer | null;
  onSetTimer: (seconds: number | null) => void;
}

/** A daisyUI dropdown is held open by focus, so a menu item that only runs its
 *  handler leaves the menu standing over the answer. */
function closeMenu() {
  (document.activeElement as HTMLElement | null)?.blur();
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
  timer,
  onSetTimer,
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
        className="min-w-0 flex-1 text-left rounded-lg px-1 -mx-1 hover:bg-base-content/5 transition-colors"
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
        <p className="text-xs text-base-content/60 flex items-center gap-2 truncate">
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
          {/* A running timer belongs on the line that already says what state
              this conversation is in, not behind a menu nobody opens. */}
          {timer?.ttlSeconds != null && (
            <span className="inline-flex items-center gap-1 text-primary shrink-0">
              <Timer className="w-3 h-3" />
              {formatTtl(timer.ttlSeconds)}
            </span>
          )}
        </p>
      </button>
      <button
        className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
        onClick={onToggleSearch}
        title="Search messages"
        aria-pressed={searchOpen}
      >
        <Search className="w-5 h-5" />
      </button>
      <div className="dropdown dropdown-end">
        <button
          tabIndex={0}
          className="btn btn-ghost btn-sm btn-square relative hover:bg-base-content/10 transition-colors"
          aria-label="Conversation options"
        >
          <MoreVertical className="w-5 h-5" />
          {/* The one thing in this menu that cannot wait to be found. */}
          {trust === 'changed' && !isSelf && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-error" />
          )}
        </button>
        <ul
          tabIndex={0}
          className="dropdown-content menu bg-base-100 rounded-box z-30 w-72 p-2 shadow"
        >
          {!isSelf && (
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  onOpenVerify();
                }}
                disabled={!peerKey}
                className={
                  trust === 'changed' ? 'text-error' : trust === 'verified' ? 'text-success' : ''
                }
              >
                {trust === 'verified' ? (
                  <ShieldCheck className="w-4 h-4" />
                ) : (
                  <ShieldAlert className="w-4 h-4" />
                )}
                {trust === 'changed'
                  ? 'Their key changed'
                  : trust === 'verified'
                    ? 'Verified — check again'
                    : 'Verify safety number'}
              </button>
            </li>
          )}
          <li>
            <details>
              <summary className="whitespace-nowrap">
                <Timer className={`w-4 h-4 ${timer?.ttlSeconds != null ? 'text-primary' : ''}`} />
                Disappearing messages
                <span className="ml-auto text-xs text-base-content/50">
                  {formatTtl(timer?.ttlSeconds ?? null)}
                </span>
              </summary>
              <ul>
                {TTL_OPTIONS.map((option) => (
                  <li key={String(option.seconds)}>
                    <button
                      className={(timer?.ttlSeconds ?? null) === option.seconds ? 'active' : ''}
                      onClick={() => {
                        closeMenu();
                        onSetTimer(option.seconds);
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </li>
          <li>
            <button
              onClick={() => {
                closeMenu();
                onOpenBackground();
              }}
            >
              <ImageIcon className="w-4 h-4" />
              Chat background
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                closeMenu();
                onOpenNickname();
              }}
            >
              <Pencil className="w-4 h-4" />
              {isSelf ? 'Name this chat' : 'Set a nickname'}
            </button>
          </li>
        </ul>
      </div>
    </header>
  );
}
