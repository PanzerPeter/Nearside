import { useEffect, useState } from 'react';
import { CalendarClock, ExternalLink, Link2, MessageSquare, X } from 'lucide-react';
import { formatListTime } from '../lib/time';
import { formatWhen, type DateInsight, type LinkInsight } from '../lib/extract';
import { useConversationInsights } from '../hooks/useConversationInsights';

interface ConversationPanelProps {
  peerId: string;
  me: string;
  peerLabel: string;
  isSelf: boolean;
  /** The thread's message count. A message arriving while the panel is open
   *  should be in it. */
  revision: number;
  onJump: (messageId: string, createdAt: string) => void;
  onClose: () => void;
}

type Tab = 'dates' | 'links';

/**
 * What this conversation turned out to contain: the days somebody named, and
 * the links somebody sent.
 *
 * Read out of the local mirror on this device, not out of a server that has no
 * bodies to read. Every row carries the phrase or the link exactly as it was
 * typed and jumps to the message it came from, so nothing here has to be taken
 * on trust — the panel is a shortcut into the conversation, never a summary
 * standing in for it.
 */
export function ConversationPanel({
  peerId,
  me,
  peerLabel,
  isSelf,
  revision,
  onJump,
  onClose,
}: ConversationPanelProps) {
  const [tab, setTab] = useState<Tab>('dates');
  const insights = useConversationInsights(peerId, true, revision);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const who = (userId: string) => (userId === me ? 'You' : isSelf ? 'You' : peerLabel);
  const dateCount = insights.upcoming.length + insights.past.length;

  return (
    <div className="bg-base-100 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.15)] shrink-0">
      <div className="flex items-center gap-2 px-4 sm:px-5 pt-2.5">
        <p className="flex-1 text-sm font-semibold">In this conversation</p>
        <button className="btn btn-ghost btn-xs btn-square" onClick={onClose} title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div role="tablist" className="tabs tabs-bordered px-3 sm:px-4">
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'dates' ? 'tab-active' : ''}`}
          onClick={() => setTab('dates')}
        >
          <CalendarClock className="w-4 h-4" />
          Dates
          <span className="text-xs text-base-content/50">{dateCount}</span>
        </button>
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'links' ? 'tab-active' : ''}`}
          onClick={() => setTab('links')}
        >
          <Link2 className="w-4 h-4" />
          Links
          <span className="text-xs text-base-content/50">{insights.links.length}</span>
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto px-3 sm:px-4 py-2 space-y-1">
        {insights.loading && insights.scanned === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-base-content/55">Reading…</p>
        ) : tab === 'dates' ? (
          <DateList
            insights={insights}
            who={who}
            onJump={onJump}
            empty={emptyReason(insights.scanned, 'No day has been named here yet.')}
          />
        ) : (
          <LinkList
            links={insights.links}
            who={who}
            onJump={onJump}
            empty={emptyReason(insights.scanned, 'No links have been sent here yet.')}
          />
        )}
      </div>

      {/* The panel reads plaintext that exists only because this device
          decrypted it. Saying so is the same claim the transparency screen
          makes, in the one place where it would be reasonable to wonder. */}
      <p className="px-4 sm:px-5 pb-2 text-[0.68rem] leading-snug text-base-content/45">
        Found on this device, in messages it already decrypted. Nothing is sent anywhere to build
        this.
      </p>
    </div>
  );
}

/** A conversation this device never loaded looks exactly like an empty one, so
 *  the two say different things. */
function emptyReason(scanned: number, nothingFound: string): string {
  return scanned === 0
    ? 'Nothing from this conversation is on this device yet. Scroll back through it and it will fill in.'
    : nothingFound;
}

interface ListProps {
  who: (userId: string) => string;
  onJump: (messageId: string, createdAt: string) => void;
  empty: string;
}

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-sm text-base-content/55">{text}</p>;
}

function DateList({
  insights,
  who,
  onJump,
  empty,
}: ListProps & { insights: { upcoming: DateInsight[]; past: DateInsight[]; now: number } }) {
  if (insights.upcoming.length === 0 && insights.past.length === 0) return <Empty text={empty} />;

  return (
    <>
      {insights.upcoming.map((event) => (
        <DateRow key={rowKey(event)} event={event} now={insights.now} who={who} onJump={onJump} />
      ))}
      {insights.past.length > 0 && (
        <p className="px-2 pt-3 pb-1 text-xs font-medium text-base-content/45">Already passed</p>
      )}
      {insights.past.map((event) => (
        <DateRow
          key={rowKey(event)}
          event={event}
          now={insights.now}
          who={who}
          onJump={onJump}
          muted
        />
      ))}
    </>
  );
}

/** One message can name two days, so the id alone is not unique. */
const rowKey = (event: DateInsight) => `${event.messageId}:${event.when}`;

function DateRow({
  event,
  now,
  who,
  onJump,
  muted = false,
}: {
  event: DateInsight;
  now: number;
  muted?: boolean;
  who: (userId: string) => string;
  onJump: (messageId: string, createdAt: string) => void;
}) {
  return (
    <button
      onClick={() => onJump(event.messageId, event.at)}
      className={`w-full text-left px-3 py-2 rounded-lg hover:bg-base-200/70 transition-colors flex gap-2.5 ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <CalendarClock className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium truncate">{formatWhen(event, now)}</span>
          <span className="text-xs text-base-content/50 shrink-0">
            {who(event.userId)} · {formatListTime(event.at)}
          </span>
        </span>
        {/* The message itself, not a paraphrase: the panel's claim is only
            that this line mentioned a day, and the line is right there to
            check it against. */}
        <span className="block text-xs text-base-content/70 line-clamp-2">{event.text}</span>
      </span>
    </button>
  );
}

function LinkList({ links, who, onJump, empty }: ListProps & { links: LinkInsight[] }) {
  if (links.length === 0) return <Empty text={empty} />;

  return (
    <>
      {links.map((link) => (
        <div
          key={link.href}
          className="flex items-center gap-1 rounded-lg hover:bg-base-200/70 transition-colors"
        >
          {/* Same whitelist as the thread's own anchors — `linkify` decided
              this was a link, and these are the attributes it renders one
              with. */}
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 flex-1 px-3 py-2 flex gap-2.5"
          >
            <ExternalLink className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium truncate">{link.label}</span>
                <span className="text-xs text-base-content/50 shrink-0">
                  {who(link.userId)} · {formatListTime(link.at)}
                </span>
              </span>
              {link.count > 1 && (
                <span className="block text-xs text-base-content/50">
                  sent {link.count} times
                </span>
              )}
            </span>
          </a>
          <button
            className="btn btn-ghost btn-xs btn-square mr-1 shrink-0"
            onClick={() => onJump(link.messageId, link.at)}
            title="Show in conversation"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </>
  );
}
