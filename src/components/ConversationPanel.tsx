import { useEffect, useState } from 'react';
import { CalendarClock, ExternalLink, Images, Link2, MessageSquare, X } from 'lucide-react';
import { formatListTime } from '../lib/time';
import { formatWhen, type DateInsight, type LinkInsight } from '../lib/extract';
import { useConversationInsights } from '../hooks/useConversationInsights';
import { useSharedMedia, type SharedMedia } from '../hooks/useSharedMedia';
import { GalleryProvider } from '../hooks/useGallery';
import { MediaAttachment } from './MediaAttachment';
import type { Message } from '../lib/types';
import { useT } from '../hooks/useT';
// `emptyReason` is a helper, not a component, so it reaches the catalog
// directly. Aliased to keep it distinct from the hook's `t` inside components.
import { t as translate } from '../lib/i18n';

interface ConversationPanelProps {
  peerId: string;
  me: string;
  peerLabel: string;
  isSelf: boolean;
  /** The thread's message count, plus whatever the history walk has fetched.
   *  A message arriving while the panel is open should be in it, and so should
   *  a page of last year's that has just been mirrored. */
  revision: number;
  /** The walk through the rest of the conversation is still running, so these
   *  lists are over a part of it. Said out loud rather than left to look like
   *  a quiet result. */
  loadingHistory?: boolean;
  /** The conversation's decrypt boundary (`ChatRoom.open`). The media tab asks
   *  the server for rows and they come back sealed, like every other read. */
  open: (rows: Message[]) => Promise<Message[]>;
  onJump: (messageId: string, createdAt: string) => void;
  onClose: () => void;
}

type Tab = 'dates' | 'links' | 'media';

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
  loadingHistory = false,
  open,
  onJump,
  onClose,
}: ConversationPanelProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('dates');
  const insights = useConversationInsights(peerId, true, revision);
  // Only while its tab is showing: a round trip and a decrypt per row is not
  // something to spend on a tab nobody opened.
  const media = useSharedMedia(me, peerId, tab === 'media', open);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Bare English until now, and invisible to the untranslated-literal scan
  // because it never reaches JSX as text — it is a string handed to a child.
  const who = (userId: string) =>
    userId === me || isSelf ? t('common.you') : peerLabel;
  const dateCount = insights.upcoming.length + insights.past.length;

  return (
    <div className="bg-base-100 border-b border-hairline shadow-[0_1px_3px_rgba(0,0,0,0.15)] shrink-0">
      <div className="flex items-center gap-2 px-4 sm:px-5 pt-2.5">
        <p className="flex-1 text-body font-semibold">{t('panel.inThisConversation')}</p>
        <button className="btn btn-ghost btn-xs btn-square" onClick={onClose} title={t('common.close')}>
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
          {t('panel.dates')}
          <span className="text-meta text-subtle">{dateCount}</span>
        </button>
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'links' ? 'tab-active' : ''}`}
          onClick={() => setTab('links')}
        >
          <Link2 className="w-4 h-4" />
          {t('panel.links')}
          <span className="text-meta text-subtle">{insights.links.length}</span>
        </button>
        <button
          role="tab"
          className={`tab gap-1.5 ${tab === 'media' ? 'tab-active' : ''}`}
          onClick={() => setTab('media')}
        >
          <Images className="w-4 h-4" />
          {t('panel.media')}
          {/* No count until the tab has been opened: a number that says nothing
              is worse than no number, and the count costs the fetch. */}
          {media.rows.length > 0 && (
            <span className="text-meta text-subtle">{media.rows.length}</span>
          )}
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto px-3 sm:px-4 py-2 space-y-1">
        {/* A line rather than a spinner in place of the lists: what has been
            read so far is already useful, and hiding it until the walk
            finishes would make an old conversation look empty for longer than
            it is. */}
        {loadingHistory && tab !== 'media' && (
          <p className="px-2 pb-1 text-meta text-muted">{t('panel.readingHistory')}</p>
        )}
        {insights.loading && insights.scanned === 0 ? (
          <p className="px-2 py-6 text-center text-body text-muted">{t('panel.reading')}</p>
        ) : tab === 'dates' ? (
          <DateList
            insights={insights}
            who={who}
            onJump={onJump}
            empty={emptyReason(insights.scanned, t('panel.noDates'))}
          />
        ) : tab === 'links' ? (
          <LinkList
            links={insights.links}
            who={who}
            onJump={onJump}
            empty={emptyReason(insights.scanned, t('panel.noLinks'))}
          />
        ) : (
          <MediaGrid media={media} />
        )}
      </div>

      {/* The panel reads plaintext that exists only because this device
          decrypted it. Saying so is the same claim the transparency screen
          makes, in the one place where it would be reasonable to wonder. */}
      <p className="px-4 sm:px-5 pb-2 text-micro leading-snug text-subtle">
        {/* Two different claims, and saying the wrong one here would be the
            kind of privacy copy this app refuses to ship: dates and links are
            read out of what this phone decrypted, while an attachment's path
            is a column the server has always held. */}
        {tab === 'media' ? t('panel.mediaProvenance') : t('panel.provenance')}
      </p>
    </div>
  );
}

/** A conversation this device never loaded looks exactly like an empty one, so
 *  the two say different things. */
function emptyReason(scanned: number, nothingFound: string): string {
  return scanned === 0 ? translate('panel.nothingLocal') : nothingFound;
}

interface ListProps {
  who: (userId: string) => string;
  onJump: (messageId: string, createdAt: string) => void;
  empty: string;
}

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-6 text-center text-body text-muted">{text}</p>;
}

/** One message can name two days, so the id alone is not unique. */
const rowKey = (event: DateInsight) => `${event.messageId}:${event.when}`;

function DateList({
  insights,
  who,
  onJump,
  empty,
}: ListProps & { insights: { upcoming: DateInsight[]; past: DateInsight[]; now: number } }) {
  const t = useT();
  if (insights.upcoming.length === 0 && insights.past.length === 0) return <Empty text={empty} />;

  return (
    <>
      {insights.upcoming.map((event) => (
        <DateRow key={rowKey(event)} event={event} now={insights.now} who={who} onJump={onJump} />
      ))}
      {insights.past.length > 0 && (
        <p className="px-2 pt-3 pb-1 text-meta font-medium text-subtle">{t('panel.alreadyPassed')}</p>
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
      className={`w-full text-left px-3 py-2 rounded-field hover:bg-base-200/70 transition-colors flex gap-2.5 ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <CalendarClock className="w-4 h-4 mt-0.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-body font-medium truncate">{formatWhen(event, now)}</span>
          <span className="text-meta text-subtle shrink-0">
            {who(event.userId)} · {formatListTime(event.at)}
          </span>
        </span>
        {/* The message itself, not a paraphrase: the panel's claim is only
            that this line mentioned a day, and the line is right there to
            check it against. */}
        <span className="block text-meta text-strong line-clamp-2">{event.text}</span>
      </span>
    </button>
  );
}

function LinkList({ links, who, onJump, empty }: ListProps & { links: LinkInsight[] }) {
  const t = useT();
  if (links.length === 0) return <Empty text={empty} />;

  return (
    <>
      {links.map((link) => (
        <div
          key={link.href}
          className="flex items-center gap-1 rounded-field hover:bg-base-200/70 transition-colors"
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
                <span className="text-body font-medium truncate">{link.label}</span>
                <span className="text-meta text-subtle shrink-0">
                  {who(link.userId)} · {formatListTime(link.at)}
                </span>
              </span>
              {link.count > 1 && (
                <span className="block text-meta text-subtle">
                  {t('panel.sentTimes', { count: link.count })}
                </span>
              )}
            </span>
          </a>
          <button
            className="btn btn-ghost btn-xs btn-square mr-1 shrink-0"
            onClick={() => onJump(link.messageId, link.at)}
            title={t('panel.showInConversation')}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * The conversation's pictures as a grid of thumbnails.
 *
 * Each tile is an ordinary `MediaAttachment`, so it draws the small sealed
 * preview the sender uploaded rather than the full file — a grid of a hundred
 * photographs costs about what one of them would. Tapping one opens the same
 * viewer the thread opens, and the provider around the grid is what lets the
 * arrows there walk the whole conversation's media instead of stopping at the
 * one that was tapped.
 */
function MediaGrid({ media }: { media: SharedMedia }) {
  const t = useT();

  if (media.loading && media.rows.length === 0) {
    return <Empty text={translate('panel.reading')} />;
  }
  // Not the empty state: "there are no pictures" is a claim, and a failed
  // request has not earned it.
  if (media.failed) return <Empty text={t('panel.mediaFailed')} />;
  if (media.rows.length === 0) return <Empty text={t('panel.noMedia')} />;

  return (
    <GalleryProvider messages={media.rows}>
      <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4">
        {media.rows.map((row) => (
          <li key={row.id} className="aspect-square overflow-hidden rounded-field bg-base-200">
            <MediaAttachment
              messageId={row.id}
              path={row.media_path as string}
              thumbPath={row.media_thumb_path}
              type={row.media_type === 'video' ? 'video' : 'image'}
              mediaKey={row.media_key}
              caption={row.text}
              expiresAt={row.expires_at}
              square
            />
          </li>
        ))}
      </ul>
    </GalleryProvider>
  );
}
