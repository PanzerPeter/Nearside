import { useT } from '../hooks/useT';
interface ProfileUnavailableProps {
  onRetry: () => void;
  onSignOut: () => void;
}

/**
 * What settings shows when the profile row will not load.
 *
 * The retry is the ordinary case — a dropped connection, a token being
 * refreshed — and it is the first button because it is usually the answer.
 *
 * Sign out is here because of the case that is not temporary: an account the
 * server no longer has. A deleted user keeps a valid-looking session on the
 * device, so the app signs in, fetches a profile that is gone, and settles on
 * this screen — with the only sign-out button in the app inside the panel that
 * needs the profile to render. That is a deadlock with no way out but clearing
 * app data, and `signOut` is what clears the local mirror, the outbox, the
 * pinned bytes, the roster and the key caches together.
 */
export function ProfileUnavailable({ onRetry, onSignOut }: ProfileUnavailableProps) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      {/* Retrying on its own already, but a spinner that has been turning for
          a while needs to say what it is waiting for. */}
      <p className="text-sm text-base-content/60">{t('rail.retrying')}</p>
      <div className="flex items-center gap-2">
        <button className="btn btn-sm btn-outline" onClick={onRetry}>
          {t('rail.tryNow')}
        </button>
        <button className="btn btn-sm btn-ghost text-error" onClick={onSignOut}>
          {t('common.signOut')}
        </button>
      </div>
      <p className="max-w-xs text-xs text-base-content/50">{t('rail.deletedHint')}</p>
    </div>
  );
}
