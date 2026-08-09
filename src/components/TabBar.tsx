import { MessageSquare, Settings } from 'lucide-react';

export type Tab = 'chats' | 'settings';

interface TabBarProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  /** Summed unread count, badged on the chats tab. */
  unread: number;
}

/**
 * The phone's primary navigation. `lg:hidden` by construction: the desktop
 * layout shows both panes at once and reaches settings from the top bar, so a
 * tab bar there would be navigating between things already on screen.
 *
 * The caller hides this while a conversation is open — the composer owns the
 * bottom edge there, and "chats" would be a no-op button anyway.
 */
export function TabBar({ tab, onSelect, unread }: TabBarProps) {
  return (
    <nav className="lg:hidden shrink-0 bg-base-100 border-t border-base-content/5 pb-[var(--safe-bottom)] z-20">
      <div className="flex">
        <TabButton
          label="Chats"
          active={tab === 'chats'}
          onClick={() => onSelect('chats')}
          badge={unread}
        >
          <MessageSquare className="w-5 h-5" />
        </TabButton>
        <TabButton label="Settings" active={tab === 'settings'} onClick={() => onSelect('settings')}>
          <Settings className="w-5 h-5" />
        </TabButton>
      </div>
    </nav>
  );
}

function TabButton({
  label,
  active,
  onClick,
  badge = 0,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // aria-current rather than aria-selected: these are navigation buttons,
      // not an ARIA tablist, and claiming that role without the keyboard
      // behaviour it implies is worse than not claiming it.
      aria-current={active ? 'page' : undefined}
      className={`flex-1 flex flex-col items-center gap-0.5 py-2 transition-colors ${
        active ? 'text-primary' : 'text-base-content/55 hover:text-base-content/80'
      }`}
    >
      {/* motion-tab-icon is the hook the expressive set animates when
          aria-current above flips to this button — see index.css. */}
      <span className="motion-tab-icon relative">
        {children}
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2.5 badge badge-xs badge-primary px-1 font-semibold">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="text-[0.6875rem] font-medium leading-none">{label}</span>
    </button>
  );
}
