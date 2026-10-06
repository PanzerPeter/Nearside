import { MessageSquare, Settings } from 'lucide-react';
import { useT } from '../hooks/useT';

export type Tab = 'chats' | 'settings';

interface TabBarProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  /** Summed unread count, badged on the chats tab. */
  unread: number;
}

/**
 * The phone's primary navigation. `md:hidden` by construction: the desktop
 * layout shows both panes at once and reaches settings from the account rail
 * at the foot of the list, so a tab bar there would be navigating between
 * things already on screen.
 *
 * The caller hides this while a conversation is open — the composer owns the
 * bottom edge there, and "chats" would be a no-op button anyway.
 */
export function TabBar({ tab, onSelect, unread }: TabBarProps) {
  const t = useT();
  return (
    <nav className="md:hidden shrink-0 bg-base-100 border-t border-hairline pb-(--safe-bottom) z-20">
      <div className="flex">
        <TabButton
          label={t('tabs.chats')}
          active={tab === 'chats'}
          onClick={() => onSelect('chats')}
          badge={unread}
        >
          <MessageSquare className="w-5 h-5" />
        </TabButton>
        <TabButton label={t('settings.title')} active={tab === 'settings'} onClick={() => onSelect('settings')}>
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
      className={`flex-1 flex flex-col items-center gap-1 py-2 transition-colors ${
        active ? 'text-base-content' : 'text-muted hover:text-strong'
      }`}
    >
      {/* motion-tab-icon is the hook the expressive set animates when
          aria-current above flips to this button — see index.css. */}
      <span
        // A tint, not a fill: the solid gradient pill was the loudest thing on
        // the screen, louder than the conversations it navigates to. The label
        // under it takes full contrast instead of the accent, which at 11px on
        // a dark bar did not carry.
        className={`motion-tab-icon relative flex items-center justify-center rounded-full px-5 py-1 transition-colors ${
          active ? 'bg-primary/20' : ''
        }`}
      >
        {children}
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2 badge badge-xs badge-primary px-1 font-semibold tabular-nums ring-2 ring-base-100">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className={`text-micro leading-none ${active ? 'font-semibold' : 'font-medium'}`}>
        {label}
      </span>
    </button>
  );
}
