import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { searchEverywhere } from '../lib/localdb';
import { groupHits, visibleHits, type SearchGroup } from '../lib/search-groups';
import { formatListTime } from '../lib/time';
import { Avatar } from '../components/Avatar';
import { Highlight } from '../components/Highlight';
import { useToast } from './useToast';
import { useT } from './useT';

/** The same floor the per-conversation search keeps: a one-character query
 *  matches most of everything and is never what somebody meant. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

/** What the chat list already knows about a conversation, so a result can be
 *  shown under a name and a face rather than under an id. */
export interface SearchTarget {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isRoom: boolean;
}

interface GlobalSearchOptions {
  me: string;
  /** Every conversation the list is holding, keyed by id. A hit in a
   *  conversation that is not in here — one left, or a group this account was
   *  removed from — is dropped rather than shown under its raw id. */
  targets: Map<string, SearchTarget>;
  onOpen: (target: SearchTarget, messageId: string, createdAt: string) => void;
}

export interface GlobalSearch {
  /** The field, for the list's header. */
  field: ReactNode;
  /** Put the cursor in it and empty it — what Ctrl/⌘+K does. */
  focus: () => void;
  /** True once the query is long enough to have an answer. The chat list hides
   *  itself while it is, rather than putting results below a list of every
   *  conversation the reader was not asking about. */
  active: boolean;
  /** The grouped results, for where the list would be. */
  results: ReactNode;
}

/**
 * Search across every conversation, from the chat list.
 *
 * The conversation search answers "where in this chat", and until now that was
 * the only question the app could answer — which meant finding something you
 * could not place began with guessing which chat it was in.
 *
 * It reads the same local mirror, for the same reason: the server has held no
 * message bodies since 0023, so the only text there is to match against is what
 * this device decrypted. A conversation this phone never opened is not
 * searchable here, which is the honest consequence of the server not being able
 * to read it either.
 */
export function useGlobalSearch({ me, targets, onOpen }: GlobalSearchOptions): GlobalSearch {
  const t = useT();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const toast = useToast();
  // Guards against a slow response for an earlier keystroke landing on top of
  // a faster one that fired after it.
  const requestId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const active = trimmed.length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (!active) {
      setGroups([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      searchEverywhere(trimmed)
        .then((rows) => {
          if (requestId.current !== id) return;
          setSearching(false);
          setGroups(groupHits(rows));
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setSearching(false);
          toast.error(t('search.failed'));
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `toast` is a stable useCallback (see useToast.tsx); as a dependency it
    // would re-fire this debounce on every render of the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, active]);

  // A hit in a conversation this account is no longer in has nothing to open
  // and nothing to be called. Dropped here rather than rendered as an id.
  const named = useMemo(
    () =>
      groups
        .map((group) => ({ group, target: targets.get(group.conversationId) }))
        .filter((row): row is { group: SearchGroup; target: SearchTarget } => !!row.target),
    [groups, targets]
  );

  const total = named.reduce((n, row) => n + row.group.hits.length, 0);

  return {
    focus: () => {
      // Emptied as well as focused. The shortcut means "find a conversation",
      // and landing in a box still holding the last search is a box whose
      // first keystroke has to be a deletion.
      setQuery('');
      inputRef.current?.focus();
    },
    field: (
      <div className="mt-2.5 flex items-center gap-2">
        <label className="input input-sm flex flex-1 items-center gap-2 border border-hairline bg-base-200/50 focus-within:border-primary">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // A search field with a value swallows Escape in some browsers to
              // clear itself; doing it here means one key behaves the same way
              // on every platform.
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('search.everywhere')}
            className="min-w-0 flex-1 bg-transparent outline-none"
            aria-label={t('search.everywhere')}
          />
          {query && (
            <button
              type="button"
              className="btn btn-ghost btn-xs btn-circle"
              onClick={() => setQuery('')}
              aria-label={t('search.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>
    ),
    active,
    results: (
      <div className="px-3 py-2 sm:px-4">
        <p className="px-1 pb-1.5 text-meta text-muted">
          {searching ? t('search.searching') : t('search.resultsEverywhere', { count: total })}
        </p>
        {!searching && named.length === 0 && (
          <p className="px-2 py-6 text-center text-body text-muted">{t('search.noneEverywhere')}</p>
        )}
        <ul className="space-y-3">
          {named.map(({ group, target }) => {
            const { shown, more } = visibleHits(group);
            return (
              <li key={group.conversationId}>
                <div className="flex items-center gap-2 px-1 pb-1">
                  <Avatar display_name={target.name} url={target.avatarUrl} size={20} />
                  <span className="truncate text-meta font-semibold text-strong">
                    {target.name}
                  </span>
                  <span className="text-meta text-subtle">{group.hits.length}</span>
                </div>
                <div className="space-y-0.5">
                  {shown.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => onOpen(target, h.id, h.created_at)}
                      className="w-full rounded-field px-3 py-2 text-left transition-colors hover:bg-base-200/70"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-meta font-medium text-strong">
                          {h.user_id === me ? t('common.you') : target.name}
                        </span>
                        <span className="shrink-0 text-meta text-muted">
                          {formatListTime(h.created_at)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-body text-strong">
                        <Highlight text={h.text} needle={trimmed} />
                      </p>
                    </button>
                  ))}
                  {more > 0 && (
                    // Not a "show more" that expands in place: the rest are in
                    // the conversation, and opening it with its own search is
                    // where they are all readable in context.
                    <p className="px-3 pt-0.5 text-meta text-subtle">
                      {t('search.moreInChat', { count: more })}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    ),
  };
}
