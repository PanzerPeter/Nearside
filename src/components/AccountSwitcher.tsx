import { useState } from 'react';
import { Plus, UserRoundX } from 'lucide-react';
import { Avatar } from './Avatar';
import { MAX_ACCOUNTS, switchTargets, type StoredAccount } from '../lib/accounts';

interface AccountSwitcherProps {
  accounts: StoredAccount[];
  currentUserId: string;
  onSwitch: (account: StoredAccount) => void;
  onForget: (account: StoredAccount) => void;
  onAddAccount: () => void;
}

/**
 * The switcher rows in settings: every other account signed in on this device,
 * one tap away.
 *
 * The account you are already on is not rendered here. Its name and avatar are
 * on the same screen a few rows up, and a row that does nothing when tapped
 * reads as broken rather than as "current".
 */
export function AccountSwitcher({
  accounts,
  currentUserId,
  onSwitch,
  onForget,
  onAddAccount,
}: AccountSwitcherProps) {
  // Which row is asking to be removed. One id rather than a boolean, so opening
  // the confirmation on a second row closes the first instead of arming two.
  const [confirmingForget, setConfirmingForget] = useState<string | null>(null);

  const targets = switchTargets(accounts, currentUserId);
  const full = accounts.length >= MAX_ACCOUNTS;

  return (
    <div className="space-y-1">
      {targets.map((account) =>
        confirmingForget === account.userId ? (
          <div key={account.userId} className="rounded-lg bg-base-200/50 p-2 space-y-2">
            <p className="text-xs text-base-content/60">
              Removes{' '}
              <span className="font-medium text-base-content/80">
                {account.display_name || 'this account'}
              </span>{' '}
              from this device — its recovery phrase, offline search index and app lock. The account
              itself is untouched; you can sign back in with your twelve words.
            </p>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost btn-xs" onClick={() => setConfirmingForget(null)}>
                Cancel
              </button>
              <button
                className="btn btn-warning btn-xs"
                onClick={() => {
                  setConfirmingForget(null);
                  onForget(account);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div key={account.userId} className="flex items-center gap-1">
            <button
              className="btn btn-ghost btn-sm flex-1 justify-start gap-2.5 px-2 min-w-0"
              onClick={() => onSwitch(account)}
            >
              <Avatar
                display_name={account.display_name || '?'}
                url={account.avatar_url}
                size={22}
              />
              <span className="flex-1 text-left truncate">
                {account.display_name ? `@${account.display_name}` : 'Signed-in account'}
              </span>
            </button>
            <button
              className="btn btn-ghost btn-sm btn-square shrink-0"
              onClick={() => setConfirmingForget(account.userId)}
              aria-label={`Remove ${account.display_name || 'this account'} from this device`}
              title="Remove from this device"
            >
              <UserRoundX className="w-4 h-4 text-base-content/40" />
            </button>
          </div>
        )
      )}

      {full ? (
        // A cap on how many resumable sessions one stolen device yields. Saying
        // so beats a button that silently drops somebody else's account.
        <p className="px-2 text-xs text-base-content/50">
          {MAX_ACCOUNTS} accounts is the limit on one device. Remove one to add another.
        </p>
      ) : (
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={onAddAccount}
        >
          <Plus className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Add another account</span>
        </button>
      )}
    </div>
  );
}
