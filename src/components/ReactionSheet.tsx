import { useMemo } from 'react';
import { Modal } from './Modal';
import { groupReactions, reactionCount } from '../lib/reaction-groups';
import type { Reaction } from '../lib/types';
import { useT } from '../hooks/useT';

interface ReactionSheetProps {
  reactions: Reaction[];
  me: string;
  /** Resolves a user id to the name this surface shows for them. A room has its
   *  member list; a thread has you and one peer. Passed in rather than looked
   *  up here, so `lib/reaction-groups.ts` stays name-free and node-testable. */
  nameFor: (userId: string) => string;
  onClose: () => void;
}

/**
 * Who reacted, and with what.
 *
 * Opened from the message menu rather than by tapping a chip. A chip's tap
 * already means "add or remove mine" — that is what its own aria-label
 * promises — and overloading it with a second meaning would make removing a
 * reaction a gamble. The menu entry appears only on a message that has
 * reactions, so it costs nothing on the ones that do not.
 *
 * The same sheet serves a group and a one-to-one. In a group it answers the
 * question the chips cannot; in a thread it is shorter but not redundant —
 * "somebody liked it" and "you liked it" are different facts, and a chip row
 * shows the same thing for both.
 */
export function ReactionSheet({ reactions, me, nameFor, onClose }: ReactionSheetProps) {
  const t = useT();
  const groups = useMemo(() => groupReactions(reactions, me), [reactions, me]);
  const total = reactionCount(groups);

  return (
    <Modal title={t('reactions.title')} onClose={onClose}>
      {total === 0 ? (
        <p className="py-6 text-center text-body text-muted">{t('reactions.none')}</p>
      ) : (
        // Capped rather than free-running: a popular message in a large group
        // would otherwise push the sheet past the viewport, and a dialog you
        // have to scroll the page behind to close is one you cannot close.
        <ul className="max-h-72 overflow-y-auto -mx-1 px-1 space-y-3">
          {groups.map((group) => (
            <li key={group.emoji}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg leading-none" aria-hidden>
                  {group.emoji}
                </span>
                <span className="text-meta text-muted">{group.count}</span>
              </div>
              <ul className="space-y-0.5 pl-7">
                {group.reactors.map((reactor) => (
                  <li
                    key={reactor.userId}
                    className={`truncate text-body ${reactor.mine ? 'font-medium' : 'text-muted'}`}
                  >
                    {reactor.mine ? t('common.you') : nameFor(reactor.userId)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
