import { formatDisplayName, nicknameFor } from '../lib/nicknames';
import type { Profile } from '../lib/types';
import { Avatar } from './Avatar';
import { useT } from '../hooks/useT';

interface MemberPickerProps {
  people: Profile[];
  unreachable: Set<string>;
  picked: ReadonlySet<string>;
  loading: boolean;
  /** What to say when there is nobody to offer — which differs between
   *  making a group and adding to one. */
  emptyLabel: string;
  onToggle: (id: string) => void;
}

/** The contact list a group is made from, and added to later. */
export function MemberPicker({
  people,
  unreachable,
  picked,
  loading,
  emptyLabel,
  onToggle,
}: MemberPickerProps) {
  const t = useT();

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <span className="loading loading-spinner" />
      </div>
    );
  }

  if (people.length === 0) {
    return <p className="text-body text-muted py-6 text-center">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-1 max-h-64 overflow-y-auto">
      {people.map((f) => {
        const noKey = unreachable.has(f.id);
        return (
          <li key={f.id}>
            <button
              type="button"
              className={`w-full flex items-center gap-2.5 p-2 rounded-field text-left transition-colors ${
                noKey
                  ? 'opacity-50 cursor-not-allowed'
                  : picked.has(f.id)
                    ? 'bg-primary/10 ring-1 ring-primary/30'
                    : 'hover:bg-wash'
              }`}
              disabled={noKey}
              aria-pressed={noKey ? undefined : picked.has(f.id)}
              onClick={() => onToggle(f.id)}
            >
              <Avatar display_name={f.display_name} seed={f.id} url={f.avatar_url} size={32} />
              <span className="flex-1 min-w-0 truncate text-body">
                {formatDisplayName(nicknameFor(f.id), f.display_name)}
              </span>
              {noKey ? (
                <span className="text-micro text-muted shrink-0">{t('rooms.noKeyPublished')}</span>
              ) : (
                <input
                  type="checkbox"
                  className="checkbox checkbox-primary checkbox-sm pointer-events-none shrink-0"
                  checked={picked.has(f.id)}
                  readOnly
                  tabIndex={-1}
                  aria-hidden
                />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
