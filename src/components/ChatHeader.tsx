import { Profile } from '../lib/types';
import type { VerificationState } from '../lib/verification';
import type { PresenceStatus } from '../lib/presence-model';
import { Avatar } from './Avatar';
import { StatusDot, presenceLabels } from './StatusDot';
import { formatLastSeen } from '../lib/time';
import { useConnection, useDegraded } from '../lib/connection';
import {
  ArrowLeft,
  Ban,
  BellRing,
  CalendarClock,
  FileDown,
  Flag,
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
import type { AlertLevel } from '../lib/chat-flags';
import type { BlockStatus } from '../lib/blocks';
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
  /** Null while presence is switched off — the line says nothing rather than
   *  reporting a grey "offline" nobody chose to publish. */
  friendStatus: PresenceStatus | null;
  searchOpen: boolean;
  onBack: () => void;
  /** Open the profile card. The avatar is the way in — it is the one thing in
   *  the header that is a picture of the person rather than a control. */
  onOpenProfile: () => void;
  onOpenNickname: () => void;
  onToggleSearch: () => void;
  onOpenVerify: () => void;
  onOpenBackground: () => void;
  /** Write this conversation out as a text file. */
  onExport: () => void;
  /** How loudly this conversation arrives, and how to change it. Muting is a
   *  separate flag with its own row in the chat list — this is the loudness a
   *  conversation returns to when it is not muted. */
  alertLevel: AlertLevel | null;
  onSetAlertLevel: (level: AlertLevel | null) => void;
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
  /** Where a block stands between the two of you. Anything but 'none' closes
   *  the conversation to new writes, so the entries that write are hidden. */
  blockStatus: BlockStatus;
  onBlock: () => void;
  onUnblock: () => void;
  onReport: () => void;
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
  onOpenProfile,
  onOpenNickname,
  onToggleSearch,
  onOpenVerify,
  onOpenBackground,
  onExport,
  alertLevel,
  onSetAlertLevel,
  onAskSealed,
  onOpenPanel,
  timer,
  onSetTimer,
  onCall,
  canCall,
  blockStatus,
  onBlock,
  onUnblock,
  onReport,
}: ChatHeaderProps) {
  // The only place in the app that mentions its own connection, and it borrows
  // a line that already exists rather than covering the top of the screen. Both
  // wordings wait out the same delay: "no connection" flashed on every tunnel
  // and lift the phone passes through, and it is the larger claim of the two.
  const t = useT();
  const { online } = useConnection();
  const blocked = blockStatus !== 'none';
  const blockedByMe = blockStatus === 'byMe' || blockStatus === 'both';
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
    <header className="flex items-center gap-2 sm:gap-3 pl-2 pr-1.5 lg:pl-5 lg:pr-3 py-2.5 pt-[calc(0.625rem+var(--safe-top))] lg:min-h-[var(--chrome-top)] bg-base-100 border-b border-hairline z-10 shrink-0">
      <button
        className="btn btn-ghost btn-sm btn-square lg:hidden hover:bg-wash transition-colors"
        onClick={onBack}
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <button
        type="button"
        className="relative shrink-0 rounded-full transition-opacity hover:opacity-80"
        style={{ width: 36, height: 36 }}
        onClick={onOpenProfile}
        title={t('profileCard.title')}
        aria-label={t('profileCard.title')}
      >
        <Avatar display_name={friend.display_name} url={friend.avatar_url} size={36} />
        {isSelf && (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-base-100 p-0.5">
            <NotebookPen className="w-3 h-3 text-primary" />
          </span>
        )}
      </button>
      {/* The name is the button that opens the nickname editor: it is the
          thing being renamed, so it needs no icon of its own to explain it. */}
      <button
        type="button"
        className="min-w-0 flex-1 text-left rounded-field px-1 -mx-1 hover:bg-wash transition-colors"
        onClick={onOpenNickname}
        title={
          isSelf ? t('chat.nameThisChat') : nickname ? friend.display_name : t('chat.setNickname')
        }
      >
        <p className="font-semibold text-body truncate flex items-center gap-1.5">
          <span className="truncate">{peerLabel}</span>
          {/* Verification as visible state, not as a coloured icon in the
              corner someone has to know to look at. A contact you took the
              trouble to verify should look verified from across the room. */}
          {trust === 'verified' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-micro font-medium text-success"
              title={t('chat.verifiedTitle')}
            >
              <ShieldCheck className="w-3 h-3" />
              {/* The word is the first thing to go when the name is long: a
                  shield in the success colour beside a name already says it,
                  and a truncated name is the worse loss. The title attribute
                  keeps the wording reachable. */}
              <span className="hidden sm:inline">{t('chat.verified')}</span>
            </span>
          )}
          {trust === 'changed' && !isSelf && (
            <span
              className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-error/15 px-1.5 py-0.5 text-micro font-medium text-error"
              title={t('chat.keyChangedTitle')}
            >
              <ShieldAlert className="w-3 h-3" />
              <span className="hidden sm:inline">{t('chat.keyChanged')}</span>
            </span>
          )}
        </p>
        <p className="text-micro text-muted flex items-center gap-2 truncate">
          {connectionNote ? (
            // No dot beside it: with our own stream down, the peer's last-known
            // status is a guess, and a green dot is not the way to say so.
            <span className="text-subtle">{connectionNote}</span>
          ) : isSelf ? (
            // Presence and last-seen would be this device reporting on
            // itself; what is worth saying here is that nobody else can read
            // any of it.
            <span>{t('chat.onlyYou')}</span>
          ) : blocked ? (
            // No presence across a block, in either direction: the app stops
            // listening for it, and a stale "last seen" would be the one
            // thing still reporting on the other person.
            <span className="inline-flex items-center gap-1.5">
              <Ban className="w-3 h-3" />
              {t('chat.blocked')}
            </span>
          ) : friendStatus ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <StatusDot status={friendStatus} size={8} pulse />
              <span className="truncate">
              {friendStatus === 'offline' && friend.last_seen_at
                ? formatLastSeen(friend.last_seen_at)
                : t(presenceLabels[friendStatus])}
              </span>
            </span>
          ) : null}
          {/* No timer chip here. This line is barely wide enough for a long
              "last seen yesterday at ..." on a phone, and the timer is not
              news — it is a setting, and it is already in the menu with its
              current value beside it. */}
        </p>
      </button>
      {/* Not in the self-chat: the vault has no second party, and a call
          button there would be a button that cannot do anything. Disabled
          rather than hidden when the peer has no key, so the reason is
          discoverable from the tooltip instead of the control vanishing. */}
      {!isSelf && (
        <>
          <button
            className="btn btn-ghost btn-sm btn-square hover:bg-wash transition-colors"
            onClick={() => onCall('voice')}
            disabled={!canCall}
            title={canCall ? t('chat.voiceCall') : t('chat.cannotCall')}
          >
            <Phone className="w-5 h-5" />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-square hover:bg-wash transition-colors"
            onClick={() => onCall('video')}
            disabled={!canCall}
            title={canCall ? t('chat.videoCall') : t('chat.cannotCall')}
          >
            <Video className="w-5 h-5" />
          </button>
        </>
      )}
      <button
        className="btn btn-ghost btn-sm btn-square hover:bg-wash transition-colors"
        onClick={onToggleSearch}
        title={t('chat.searchMessages')}
        aria-pressed={searchOpen}
      >
        <Search className="w-5 h-5" />
      </button>
      <div className="dropdown dropdown-end">
        <button
          tabIndex={0}
          className="btn btn-ghost btn-sm btn-square relative hover:bg-wash transition-colors"
          aria-label={t('chat.options')}
        >
          <MoreVertical className="w-5 h-5" />
          {/* The one thing in this menu that cannot wait to be found. */}
          {trust === 'changed' && !isSelf && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-error" />
          )}
        </button>
        {/* Sized to its content and capped at the viewport, like `MessageMenu`
            and `RowMenu`. A fixed width was narrower than these rows are — an
            icon, a label, the current answer and the disclosure chevron, none
            of which wrap — so the last two sat out over the panel's rounded
            edge, and did it in English before any translation made the labels
            longer. */}
        <ul
          tabIndex={0}
          className="dropdown-content menu z-30 mt-1 w-max max-w-[calc(100vw-1rem)] rounded-box border border-hairline bg-base-100 p-2 shadow-overlay"
        >
          {/* First in the menu because it is the one entry here that does
              something rather than configures something. Absent in the
              self-chat: an exchange with yourself has nothing to withhold, and
              the CHECK constraint on `sealed_prompt` refuses the row anyway. */}
          {!isSelf && !blocked && (
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
          {!blocked && (
          <li>
            <details>
              <summary>
                <Timer className={`w-4 h-4 ${timer?.ttlSeconds != null ? 'text-primary' : ''}`} />
                {t('chat.disappearing')}
                <span className="ml-auto text-meta text-subtle">
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
          )}
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
          <li>
            <details>
              <summary>
                <BellRing className={`w-4 h-4 ${alertLevel ? 'text-primary' : ''}`} />
                {t('alerts.title')}
                <span className="ml-auto text-meta text-subtle">
                  {t(alertLevel === 'quiet' ? 'alerts.quiet' : alertLevel === 'urgent' ? 'alerts.urgent' : 'alerts.default')}
                </span>
              </summary>
              <ul>
                {([null, 'quiet', 'urgent'] as const).map((level) => (
                  <li key={level ?? 'default'}>
                    <button
                      className={alertLevel === level ? 'active' : ''}
                      onClick={() => {
                        closeMenu();
                        onSetAlertLevel(level);
                      }}
                    >
                      {t(level === 'quiet' ? 'alerts.quiet' : level === 'urgent' ? 'alerts.urgent' : 'alerts.default')}
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
                onExport();
              }}
            >
              <FileDown className="w-4 h-4" />
              {t('chat.export')}
            </button>
          </li>
          {/* Last, and apart from the rest: these two are about the person,
              not the conversation's settings. */}
          {!isSelf && (
            <>
              <li>
                <button
                  onClick={() => {
                    closeMenu();
                    if (blockedByMe) onUnblock();
                    else onBlock();
                  }}
                >
                  <Ban className="w-4 h-4" />
                  {blockedByMe ? t('chat.unblock') : t('chat.block')}
                </button>
              </li>
              <li>
                <button
                  className="text-error"
                  onClick={() => {
                    closeMenu();
                    onReport();
                  }}
                >
                  <Flag className="w-4 h-4" />
                  {t('chat.report')}
                </button>
              </li>
            </>
          )}
        </ul>
      </div>
    </header>
  );
}
