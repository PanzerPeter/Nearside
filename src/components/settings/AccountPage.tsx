import { useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { LogOut } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Profile } from '../../lib/types';
import { confirmsUsername } from '../../lib/account';
import type { StoredAccount } from '../../lib/accounts';
import { clearAll } from '../../lib/outbox';
import { clearLocalDb } from '../../lib/localdb';
import { clearPinnedMedia } from '../../lib/pins';
import { clearSeed } from '../../lib/keystore';
import { useToast } from '../../hooks/useToast';
import { AccountSwitcher } from '../AccountSwitcher';
import { Card } from './SettingsUi';

// functions.invoke surfaces a non-2xx as a generic "Edge Function returned a
// non-2xx status code", which tells the user nothing. The real reason is in
// the JSON body hanging off `context`, so dig it out before falling back.
async function invokeErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const body: unknown = await context.json().catch(() => null);
    const message = (body as { error?: unknown } | null)?.error;
    if (typeof message === 'string' && message) return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

interface AccountPageProps {
  session: Session;
  profile: Profile;
  /** Runs App.signOut, which tears down far more than the session. */
  onSignOut: () => void;
  /** Every account signed in on this device, current one included. */
  accounts: StoredAccount[];
  onSwitchAccount: (account: StoredAccount) => void;
  onForgetAccount: (account: StoredAccount) => void;
  onAddAccount: () => void;
}

export function AccountPage({
  session,
  profile,
  onSignOut,
  accounts,
  onSwitchAccount,
  onForgetAccount,
  onAddAccount,
}: AccountPageProps) {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();

  async function handleDeleteAccount() {
    // Re-checked here and not only on the button's `disabled`: the gate is the
    // whole point of this flow, and a disabled attribute is a hint, not a lock.
    if (deleting || !confirmsUsername(deleteText, profile.display_name)) return;
    setDeleting(true);

    const { error: invokeError } = await supabase.functions.invoke('delete-account');
    if (invokeError) {
      setDeleting(false);
      toast.error(await invokeErrorMessage(invokeError, 'Could not delete your account.'));
      return;
    }

    // The session now points at a user that no longer exists, so sign out
    // before reloading — otherwise the app boots with a token it cannot use.
    // The reload is in `finally` because the account is already gone by this
    // point: if signOut's network call fails, stranding the user on a spinner
    // for a deleted account is worse than reloading with a stale token, which
    // the boot path discards anyway.
    try {
      // The server side of this account is gone; unsent drafts sitting in
      // IndexedDB are the last copy of the user's content on this device, and
      // "delete my account" has to mean them too. So are this account's
      // decrypted mirror and its private key — leaving either behind would keep
      // a deleted account's plaintext and key material on a phone that may well
      // have another account signed into it.
      await clearAll();
      // Before `clearLocalDb`: the pin rows are the only map to the decrypted
      // files in the sandbox, and a deleted account must not leave its photos
      // and voice notes behind on a phone somebody else uses.
      await clearPinnedMedia().catch(() => {});
      await clearLocalDb();
      await clearSeed(session.user.id);
      await supabase.auth.signOut();
    } finally {
      window.location.reload();
    }
  }

  return (
    <>
      {/* `AccountSwitcher` deliberately omits the account you are already on,
          on the grounds that its name is a few rows up — which was true of the
          old single-page settings and is not true of a page reached from a
          list. So the page says it. */}
      <p className="text-xs text-base-content/60 px-1 mb-2">
        Signed in as{' '}
        <span className="font-medium text-base-content/80">{profile.display_name}</span>
      </p>

      {/* Above sign-out rather than below it: switching is the everyday action
          and signing out is the one you take once. */}
      <div className="mb-4">
        <AccountSwitcher
          accounts={accounts}
          currentUserId={session.user.id}
          onSwitch={onSwitchAccount}
          onForget={onForgetAccount}
          onAddAccount={onAddAccount}
        />
      </div>

      <Card>
        {confirmingSignOut ? (
          <div className="p-3 space-y-2.5">
            {/* Confirmed rather than one-tap, which is what it was in the top
                bar: signing out drops queued-but-unsent messages and this
                account's decrypted mirror, so search and previews are rebuilt
                from scratch afterwards. Nothing sent is lost. */}
            <p className="text-xs text-base-content/70">
              Unsent messages and this device&apos;s offline search index are cleared. Your
              conversations stay on the server, sealed.
            </p>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingSignOut(false)}>
                Cancel
              </button>
              <button className="btn btn-warning btn-sm" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <button
            className="w-full text-left hover:bg-base-content/5"
            onClick={() => setConfirmingSignOut(true)}
          >
            <span className="flex items-center gap-2.5 px-3 py-2.5">
              <LogOut className="w-4 h-4 text-base-content/60 shrink-0" />
              <span className="text-sm font-medium">Sign out</span>
            </span>
          </button>
        )}
      </Card>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-error px-1">Danger zone</p>
        {confirmingDelete ? (
          <>
            <p className="text-xs text-base-content/60 px-1">
              Type <span className="font-medium text-base-content/80">{profile.display_name}</span>{' '}
              to confirm. This cannot be undone.
            </p>
            <input
              type="text"
              className="input input-sm w-full bg-base-200/50 border border-base-content/10 focus:border-error"
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              // Mobile keyboards capitalise and autocorrect by default, which
              // would silently keep the confirm button disabled.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Type your display name to confirm deletion"
            />
            <div className="flex items-center gap-2">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setConfirmingDelete(false);
                  setDeleteText('');
                }}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn btn-error btn-sm"
                onClick={() => void handleDeleteAccount()}
                disabled={deleting || !confirmsUsername(deleteText, profile.display_name)}
              >
                {deleting ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  'Permanently delete'
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-base-content/60 px-1">
              Permanently deletes your account, messages and media. This cannot be undone.
            </p>
            <button
              className="btn btn-error btn-outline btn-sm"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete account
            </button>
          </>
        )}
      </div>
    </>
  );
}
