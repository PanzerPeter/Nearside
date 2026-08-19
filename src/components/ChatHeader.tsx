import { Profile } from '../lib/types';
import type { VerificationState } from '../lib/verification';
import type { PresenceStatus } from '../lib/presence-model';
import { Avatar } from './Avatar';
import { StatusDot, presenceLabels } from './StatusDot';
import { formatLastSeen } from '../lib/time';
import { useConnection, useDegraded } from '../lib/connection';
import {
  ArrowLeft,
  CalendarClock,
  Image as ImageIcon,
  Lock,
  MoreVertical,
  NotebookPen,
  Pencil,
  Phone,
  Search,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Video,
} from 'lucide-react';
import type { CallKind } from '../lib/call/types';
import { formatTtl, TTL_OPTIONS, type ConversationTimer } from '../lib/disappearing';
import { useT } from '../hooks/useT';

interface ChatHeaderProps {
  friend: Profile;
  /** How to name the other participant — a nickname if one is set,
   *  `@display_name` otherwise. */
  peerLabel: string;
  /** Set when the label above is a nickname, in which case the real handle is
   *  not on screen at all — the header is narrow and two names for one person
   *  crowd it. The nickname editor behind this button is where it lives. */
  nickname: string | null;
  isSelf: boolean;
  trust: VerificationState;
  /** Null when the peer has published no key; there is nothing to compare, so
   *  the verify button has nothing to open. */
  peerKey: Uint8Array | null;
  friendStatus: PresenceStatus;
  searchOpen: boolean;
  onBack: () => void;
  onOpenNickname: () => void;
  onToggleSearch: () => void;
  onOpenVerify: () => void;
  onOpenBackground: () => void;
  /** Open the sealed-question composer. Never reached in the self-chat. */
  onAskSealed: () => void;
  /** Open the dates-and-links panel for this conversation. */
  onOpenPanel: () => void;
  /** The conversation's timer, or null when there has never been one. Either
   *  participant may change it; `setBy` is who did last. */
  timer: ConversationTimer | null;
  onSetTimer: (seconds: number | null) => void;
  /** Place a call. Absent in the self-chat, where there is nobody to call. */
  onCall: (kind: CallKind) => void;
  /** False while another call is running, or when the peer has published no
   *  key — a call is sealed to that key exactly like a message, so there is
   *  nothing to dial. */
  canCall: boolean;
}

/** How long realtime has to stay down before this header mentions it. The app
 *  reconnects itself in silence, and keeps sending and receiving over the
 *  polling fallback meanwhile, so a shorter delay would only put a line on
 *  screen for outages that fix themselves before anybody reads it. */
const CONNECTION_NOTICE_MS = 10_000;

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
  searchOpen,
  onBack,
  onOpenNickname,
  onToggleSearch,
  onOpenVerify,
  onOpenBackground,
  onAskSealed,
  onOpenPanel,
  timer,
  onSetTimer,
  onCall,
  canCall,
}: ChatHeaderProps) {
  // The only place in the app that mentions its own connection, and it borrows
  // a line that already exists rather than covering the top of the screen. Both
  // wordings wait out the same delay: "no connection" flashed on every tunnel
  // and lift the phone passes through, and it is the larger claim of the two.
  const t = useT();
  const { online } = useConnection();
  const connectionNote = useDegraded(CONNECTION_NOTICE_MS)
    ? online
      ? t('chat.connecting')
      : t('chat.noConnection')
    : null;

  // The phone's top edge: this bar is the first thing under the status bar, so
  // it carries the inset itself and puts its own background behind the clock.
  // `lg:` takes it back off — on desktop App's top bar sits above this one and
  // has already paid it. The left padding is tighter than the right because on
  // a phone the back arrow's own hit area supplies the rest of the gap.
  return (
    <header className="flex items-center gap-2 sm:gap-3 pl-2 pr-1.5 lg:pl-5 lg:pr-3 py-2.5 pt-[calc(0.625rem+var(--safe-top))] bg-base-100 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.25)] z-10 shrink-0">
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
        title={
          isSelf ? t('chat.nameThisChat') : nickname ? `@${friend.display_name}` : t('chat.setNickname')
        }
      >
        <p className="font-semibold text-sm truncate flex items-center gap-1.5">
          <span className="truncate">{peerLabel}</span>
          {/* Verification as visible state, not as a coloured icon in the
              corner someone has to know to look at. A contact you took the
              trouble to verify should look verified from across the room. */}
          {trust === 'verified' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-success"
              title={t('chat.verifiedTitle')}
            >
              <ShieldCheck className="w-3 h-3" />
              {t('chat.verified')}
            </span>
          )}
          {trust === 'changed' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-error/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-error"
              title={t('chat.keyChangedTitle')}
            >
              <ShieldAlert className="w-3 h-3" />
              {t('chat.keyChanged')}
            </span>
          )}
        </p>
        <p className="text-xs text-base-content/60 flex items-center gap-2 truncate">
          {connectionNote ? (
            // No dot beside it: with our own stream down, the peer's last-known
            // status is a guess, and a green dot is not the way to say so.
            <span className="text-base-content/50">{connectionNote}</span>
          ) : isSelf ? (
            // Presence and last-seen would be this device reporting on
            // itself; what is worth saying here is that nobody else can read
            // any of it.
            <span>{t('chat.onlyYou')}</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={friendStatus} size={8} pulse />
              {friendStatus === 'offline' && friend.last_seen_at
                ? formatLastSeen(friend.last_seen_at)
                : t(presenceLabels[friendStatus])}
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
      {/* Not in the self-chat: the vault has no second party, and a call
          button there would be a button that cannot do anything. Disabled
          rather than hidden when the peer has no key, so the reason is
          discoverable from the tooltip instead of the control vanishing. */}
      {!isSelf && (
        <>
          <button
            className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
            onClick={() => onCall('voice')}
            disabled={!canCall}
            title={canCall ? t('chat.voiceCall') : t('chat.cannotCall')}
          >
            <Phone className="w-5 h-5" />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
            onClick={() => onCall('video')}
            disabled={!canCall}
            title={canCall ? t('chat.videoCall') : t('chat.cannotCall')}
          >
            <Video className="w-5 h-5" />
          </button>
        </>
      )}
      <button
        className="btn btn-ghost btn-sm btn-square hover:bg-base-content/10 transition-colors"
        onClick={onToggleSearch}
        title={t('chat.searchMessages')}
        aria-pressed={searchOpen}
      >
        <Search className="w-5 h-5" />
      </button>
      <div className="dropdown dropdown-end">
        <button
          tabIndex={0}
          className="btn btn-ghost btn-sm btn-square relative hover:bg-base-content/10 transition-colors"
          aria-label={t('chat.options')}
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
          {/* First in the menu because it is the one entry here that does
              something rather than configures something. Absent in the
              self-chat: an exchange with yourself has nothing to withhold, and
              the CHECK constraint on `sealed_prompt` refuses the row anyway. */}
          {!isSelf && (
            <li>
              <button
                onClick={() => {
                  closeMenu();
                  onAskSealed();
                }}
                disabled={!peerKey}
              >
                <Lock className="w-4 h-4" />
                {t('chat.askSealed')}
              </button>
            </li>
          )}
          {/* Beside the sealed question rather than under the settings below:
              both are things to do with the conversation, and this one is the
              way back into what was already said in it. Present in the
              self-chat too — notes collect links and dates like any other
              conversation. */}
          <li>
            <button
              onClick={() => {
                closeMenu();
                onOpenPanel();
              }}
            >
              <CalendarClock className="w-4 h-4" />
              {t('chat.inThisConversation')}
            </button>
          </li>
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
                  ? t('chat.theirKeyChanged')
                  : trust === 'verified'
                    ? t('chat.verifyAgain')
                    : t('chat.verifySafetyNumber')}
              </button>
            </li>
          )}
          <li>
            <details>
              <summary className="whitespace-nowrap">
                <Timer className={`w-4 h-4 ${timer?.ttlSeconds != null ? 'text-primary' : ''}`} />
                {t('chat.disappearing')}
                <span className="ml-auto text-xs text-base-content/50">
                  {formatTtl(timer?.ttlSeconds ?? null)}
                </span>
              </summary>
              <ul>
                {TTL_OPTIONS.map((seconds) => (
                  <li key={String(seconds)}>
                    <button
                      className={(timer?.ttlSeconds ?? null) === seconds ? 'active' : ''}
                      onClick={() => {
                        closeMenu();
                        onSetTimer(seconds);
                      }}
                    >
                      {formatTtl(seconds)}
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
              {t('chat.background')}
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
              {isSelf ? t('chat.nameThisChat') : t('chat.setNickname')}
            </button>
          </li>
        </ul>
      </div>
    </header>
  );
}
