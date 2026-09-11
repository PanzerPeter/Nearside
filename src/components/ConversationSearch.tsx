import { useEffect, useRef, useState } from 'react';
import { searchCached } from '../lib/localdb';
import { formatListTime } from '../lib/time';
import { useToast } from '../hooks/useToast';
import { Search, X } from 'lucide-react';
import { useT } from '../hooks/useT';
import { Highlight } from './Highlight';

/** Kept from search_messages()'s server-side floor: a one-character query
 *  matches most of a conversation and is never what someone meant. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;
/**
 * Floor between two re-runs provoked by the history walk rather than by
 * typing.
 *
 * The keystroke debounce cannot do this job: it restarts on every change, and
 * pages land faster than it expires, so a walk would hold the search off until
 * it finished — the opposite of showing results as they arrive. This one
 * counts from the last query actually run, so the wait only ever shrinks.
 */
const REFRESH_MS = 600;

interface SearchHit {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
}

interface ConversationSearchProps {
  peerId: string;
  me: string;
  /** How to name the other side in this panel — a nickname if one is set,
   *  `@display_name` otherwise. Formatted by the caller, which already holds it. */
  peerLabel: string;
  /** True for the self-chat, where there is no other side to name. */
  isSelf?: boolean;
  /** How to name the sender of a hit. A 1:1 thread has two possible answers and
   *  needs none of this; a group has one per member, and a result list that
   *  named them all after the group would be no better than not naming them. */
  senderName?: (userId: string) => string;
  /** The walk through the rest of this conversation is still running. Results
   *  so far are over the part of it that has been mirrored. */
  loadingHistory?: boolean;
  /** Rows the walk has fetched. Re-runs the query as the history lands, so an
   *  old message appears in the list the moment it is mirrored rather than
   *  after somebody types another character. */
  historyRevision?: number;
  onJump: (messageId: string, createdAt: string) => void;
  onClose: () => void;
}

/** Search panel for one conversation, docked under the chat header. */
export function ConversationSearch({
  peerId,
  me,
  peerLabel,
  isSelf = false,
  senderName,
  loadingHistory = false,
  historyRevision = 0,
  onJump,
  onClose,
}: ConversationSearchProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a slow response for an earlier keystroke overwriting the
  // results of a faster one that fired after it.
  const requestId = useRef(0);
  /** The last query put to the mirror, and when — so a re-run caused by the
   *  history landing can be told apart from one caused by typing. */
  const lastQuery = useRef('');
  const lastRunAt = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const id = ++requestId.current;
    const typed = trimmed !== lastQuery.current;
    const wait = typed
      ? DEBOUNCE_MS
      : Math.max(0, REFRESH_MS - (Date.now() - lastRunAt.current));
    // Local, not an RPC: 0023 took message bodies away from the server, so the
    // only place a body exists to match against is the mirror this device
    // built as it decrypted them. A message this device has never opened is
    // therefore not findable here — which is why opening this panel starts the
    // walk that opens the rest of the conversation (`useHistoryBackfill`), and
    // why the query re-runs as its pages land.
    const timer = setTimeout(() => {
      lastQuery.current = trimmed;
      lastRunAt.current = Date.now();
      searchCached(peerId, trimmed)
        .then((rows) => {
          if (requestId.current !== id) return; // superseded — drop this response
          setSearching(false);
          setResults(rows as SearchHit[]);
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setSearching(false);
          toast.error(t('search.failed'));
        });
    }, wait);

    return () => clearTimeout(timer);
    // toast is a stable useCallback (see useToast.tsx); omitting it here
    // keeps a fresh toast reference from re-firing this debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, peerId, historyRevision]);

  const trimmedQuery = query.trim();
  const showResults = trimmedQuery.length >= MIN_QUERY_LENGTH;

  return (
    <div className="bg-base-100 border-b border-hairline shadow-[0_1px_3px_rgba(0,0,0,0.15)] shrink-0">
      <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5">
        <Search className="w-4 h-4 text-muted shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            isSelf ? t('search.placeholderSelf') : t('search.placeholder', { name: peerLabel })
          }
          className="input input-sm flex-1 bg-base-200/50 border border-hairline focus:border-primary"
        />
        <button
          className="btn btn-ghost btn-sm btn-square"
          onClick={onClose}
          title={t('search.close')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {showResults && (
        <div className="px-4 sm:px-5 pb-2.5">
          <p className="text-meta text-muted mb-1.5">
            {searching
              ? t('search.searching')
              : loadingHistory
                ? // The count is real but not final, and a bare "0 results"
                  // while the older half of the conversation is still being
                  // fetched is the app answering a question it has not read yet.
                  t('search.resultsSoFar', { count: results.length })
                : t('search.results', { count: results.length })}
          </p>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {results.map((hit) => (
              <button
                key={hit.id}
                onClick={() => onJump(hit.id, hit.created_at)}
                className="w-full text-left px-3 py-2 rounded-field hover:bg-base-200/70 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-meta font-medium text-strong">
                    {senderName
                      ? senderName(hit.user_id)
                      : hit.user_id === me
                        ? t('common.you')
                        : peerLabel}
                  </span>
                  <span className="text-meta text-muted shrink-0">
                    {formatListTime(hit.created_at)}
                  </span>
                </div>
                <p className="text-body line-clamp-2 text-strong">
                  <Highlight text={hit.text} needle={trimmedQuery} />
                </p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
