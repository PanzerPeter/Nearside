import { Reaction } from '../lib/types';

interface ReactionChipsProps {
  reactions: Reaction[];
  me: string;
  onToggle: (emoji: string) => void;
}

export function ReactionChips({ reactions, me, onToggle }: ReactionChipsProps) {
  if (reactions.length === 0) return null;

  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const e = counts.get(r.emoji) ?? { count: 0, mine: false };
    e.count += 1;
    if (r.user_id === me) e.mine = true;
    counts.set(r.emoji, e);
  }

  return (
    <div className="flex flex-nowrap gap-1">
      {[...counts.entries()].map(([emoji, { count, mine }]) => (
        <button
          key={emoji}
          onClick={() => onToggle(emoji)}
          aria-label={`${emoji} ${count}, tap to ${mine ? 'remove your' : 'add a'} reaction`}
          // Matched to the enlarged quick-react bar: a chip is the control for
          // *undoing* a reaction, so it can't be meaningfully harder to hit
          // than the one that added it. min-h-7 keeps a one-emoji chip from
          // collapsing below a thumb-sized target.
          className={`motion-chip inline-flex items-center gap-1 rounded-full px-2.5 py-1 min-h-7 text-sm leading-none border transition-colors ${
            mine
              ? 'bg-primary/20 border-primary/40'
              : 'bg-base-100 border-base-content/10 hover:border-base-content/20'
          }`}
        >
          <span>{emoji}</span>
          <span className="text-xs text-base-content/60">{count}</span>
        </button>
      ))}
    </div>
  );
}
