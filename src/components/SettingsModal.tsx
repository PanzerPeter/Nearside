import { Session } from '@supabase/supabase-js';
import { Profile } from '../lib/types';
import { Modal } from './Modal';
import { SettingsPanel } from './SettingsPanel';
import { ProfileUnavailable } from './ProfileUnavailable';
import type { AppLock } from '../hooks/useAppLock';
import type { StoredAccount } from '../lib/accounts';

interface SettingsModalProps {
  session: Session;
  /** Null while the row is loading, and when it will not load at all. */
  profile: Profile | null;
  onUpdated: (profile: Profile) => void;
  onSignOut: () => void;
  onClose: () => void;
  /** The last profile fetch came back with nothing. */
  profileFailed: boolean;
  onRetryProfile: () => void;
  /** Threaded from `App` rather than built here: one state machine, or the
   *  gate and the toggle disagree. */
  appLock: AppLock;
  accounts: StoredAccount[];
  onSwitchAccount: (account: StoredAccount) => void;
  onForgetAccount: (account: StoredAccount) => void;
  onAddAccount: () => void;
}

/**
 * The desktop route into settings, where both panes stay on screen and a
 * dialog is the right shape. The phone renders the same `SettingsPanel` as a
 * tab instead — see `App`.
 *
 * There is no Save action down here: the panel commits the display name beside
 * the field, because as a full-screen tab it has no footer to reach. The title
 * stays "Settings" while a subpage is open rather than following it — the page
 * carries its own heading and back chevron, and two titles disagreeing about
 * where you are is worse than one being general.
 *
 * The dialog opens without a profile on purpose. Everything the panel edits
 * needs that row, but sign-out does not, and gating the whole dialog on it left
 * an account whose profile will not load with nothing to press.
 */
export function SettingsModal({
  session,
  profile,
  onUpdated,
  onSignOut,
  onClose,
  profileFailed,
  onRetryProfile,
  appLock,
  accounts,
  onSwitchAccount,
  onForgetAccount,
  onAddAccount,
}: SettingsModalProps) {
  return (
    <Modal
      title="Settings"
      onClose={onClose}
      className="max-w-md"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {profile ? (
        <SettingsPanel
          session={session}
          profile={profile}
          onUpdated={onUpdated}
          onSignOut={onSignOut}
          appLock={appLock}
          accounts={accounts}
          onSwitchAccount={onSwitchAccount}
          onForgetAccount={onForgetAccount}
          onAddAccount={onAddAccount}
        />
      ) : profileFailed ? (
        <ProfileUnavailable onRetry={onRetryProfile} onSignOut={onSignOut} />
      ) : (
        <div className="flex justify-center py-10">
          <span className="loading loading-spinner text-primary" />
        </div>
      )}
    </Modal>
  );
}
