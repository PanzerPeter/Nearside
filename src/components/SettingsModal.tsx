import { Session } from '@supabase/supabase-js';
import { Profile } from '../lib/types';
import { Modal } from './Modal';
import { SettingsPanel } from './SettingsPanel';
import type { AppLock } from '../hooks/useAppLock';
import type { StoredAccount } from '../lib/accounts';

interface SettingsModalProps {
  session: Session;
  profile: Profile;
  onUpdated: (profile: Profile) => void;
  onSignOut: () => void;
  onClose: () => void;
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
 * the field, because as a full-screen tab it has no footer to reach.
 */
export function SettingsModal({
  session,
  profile,
  onUpdated,
  onSignOut,
  onClose,
  appLock,
  accounts,
  onSwitchAccount,
  onForgetAccount,
  onAddAccount,
}: SettingsModalProps) {
  return (
    <Modal
      title="Profile settings"
      onClose={onClose}
      className="max-w-md"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
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
    </Modal>
  );
}
