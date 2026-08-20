import { AlertTriangle, Settings } from 'lucide-react';
import { Avatar } from './Avatar';
import { Profile } from '../lib/types';
import { useT } from '../hooks/useT';

interface AccountRailProps {
  /** Null while the row is still being fetched, and when it will not load. */
  profile: Profile | null;
  /** The last fetch came back with nothing — see `App.profileFailed`. */
  profileFailed: boolean;
  onOpenSettings: () => void;
}

/**
 * The desktop account row, pinned to the bottom of the conversation list.
 *
 * It is the only route into settings on this layout, so it renders in every
 * profile state rather than waiting for the row. It used to live in a top bar
 * behind `profile && …`, which meant an account whose profile will not load —
 * a deleted user holding a session the device still believes in — had no
 * settings, and therefore no sign-out, and therefore no way off the screen but
 * clearing app data.
 *
 * `lg:` only: the phone reaches the same panel through the tab bar, and a
 * second permanent row above it would cost a conversation.
 */
export function AccountRail({ profile, profileFailed, onOpenSettings }: AccountRailProps) {
  const t = useT();
  return (
    // The tab bar is `lg:hidden`, so on a tablet wide enough for this layout
    // the rail is what sits on the bottom edge and has to inset itself.
    <div className="hidden lg:block shrink-0 border-t border-base-content/5 bg-base-100 p-2 pb-[calc(0.5rem+var(--safe-bottom))]">
      <button
        type="button"
        onClick={onOpenSettings}
        title={profileFailed ? t('rail.profileFailedTitle') : t('rail.profileSettings')}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-base-content/5 focus-visible:bg-base-content/5"
      >
        {profile ? (
          <Avatar display_name={profile.display_name} url={profile.avatar_url} size={32} />
        ) : profileFailed ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
          </span>
        ) : (
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-base-content/10" />
        )}

        <span className="min-w-0 flex-1">
          {profile ? (
            <span className="block truncate text-sm font-medium text-base-content">
              {profile.display_name}
            </span>
          ) : profileFailed ? (
            <span className="block truncate text-sm font-medium text-warning">
              {t('rail.profileUnavailable')}
            </span>
          ) : (
            <span className="block h-3.5 w-24 animate-pulse rounded bg-base-content/10" />
          )}
        </span>

        <Settings className="h-4 w-4 shrink-0 text-base-content/50 transition-colors group-hover:text-base-content/80" />
      </button>
    </div>
  );
}
