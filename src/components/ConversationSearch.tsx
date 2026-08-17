import { useEffect, useRef, useState } from 'react';
import { searchCached } from '../lib/localdb';
import { formatListTime } from '../lib/time';
import { useToast } from '../hooks/useToast';
import { Search, X } from 'lucide-react';
import { useT } from '../hooks/useT';

/** Kept from search_messages()'s server-side floor: a one-character query
 *  matches most of a conversation and is never what someone meant. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

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
  onJump: (messageId: string, createdAt: string) => void;
  onClose: () => void;
}

/** Regex metacharacters that would otherwise break `new RegExp` below —
 *  distinct from the SQL LIKE metacharacters the migration escapes. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wrap every case-insensitive occurrence of `needle` in `text` with <mark>. */
function highlight(text: string, needle: string) {
  if (!needle) return text;
  // Splitting on a capturing group keeps the matched substrings themselves in
  // the output array (at the odd indices), so no separate matching pass over
  // the string is needed to know which piece to wrap.
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-warning/30 text-base-content rounded px-0.5">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/** Search panel for one conversation, docked under the chat header. */
export function ConversationSearch({
  peerId,
  me,
  peerLabel,
  isSelf = false,
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
    // Local, not an RPC: 0023 took message bodies away from the server, so the
    // only place a body exists to match against is the mirror this device
    // built as it decrypted them. A message this device has never opened is
    // therefore not findable here — correct, and the honest consequence of the
    // server not being able to read it either.
    const timer = setTimeout(() => {
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
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // toast is a stable useCallback (see useToast.tsx); omitting it here
    // keeps a fresh toast reference from re-firing this debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, peerId]);

  const trimmedQuery = query.trim();
  const showResults = trimmedQuery.length >= MIN_QUERY_LENGTH;

  return (
    <div className="bg-base-100 border-b border-base-content/5 shadow-[0_1px_3px_rgba(0,0,0,0.15)] shrink-0">
      <div className="flex items-center gap-2 px-4 sm:px-5 py-2.5">
        <Search className="w-4 h-4 text-base-content/55 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            isSelf ? t('search.placeholderSelf') : t('search.placeholder', { name: peerLabel })
          }
          className="input input-sm flex-1 bg-base-200/50 border border-base-content/10 focus:border-primary"
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
          <p className="text-xs text-base-content/55 mb-1.5">
            {searching
              ? t('search.searching')
              : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </p>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {results.map((hit) => (
              <button
                key={hit.id}
                onClick={() => onJump(hit.id, hit.created_at)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-base-200/70 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-base-content/70">
                    {hit.user_id === me ? 'You' : peerLabel}
                  </span>
                  <span className="text-xs text-base-content/55 shrink-0">
                    {formatListTime(hit.created_at)}
                  </span>
                </div>
                <p className="text-sm line-clamp-2 text-base-content/80">
                  {highlight(hit.text, trimmedQuery)}
                </p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
