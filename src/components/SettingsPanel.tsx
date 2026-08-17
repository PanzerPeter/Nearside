import { useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { Profile, initial } from '../lib/types';
import type { StoredAccount } from '../lib/accounts';
import type { AppLock } from '../hooks/useAppLock';
import { APP_VERSION } from '../lib/version';
import type { MessageKey } from '../lib/i18n';
import {
  Bell,
  ChevronRight,
  HardDrive,
  Info,
  Languages,
  Lock,
  Palette,
  PhoneCall,
  Users,
} from 'lucide-react';
import { Card, NavRow, SettingsPage } from './settings/SettingsUi';
import { ProfilePage } from './settings/ProfilePage';
import { NotificationsPage } from './settings/NotificationsPage';
import { CallsPage } from './settings/CallsPage';
import { PrivacyPage } from './settings/PrivacyPage';
import { AppearancePage } from './settings/AppearancePage';
import { StoragePage } from './settings/StoragePage';
import { AboutPage } from './settings/AboutPage';
import { AccountPage } from './settings/AccountPage';
import { LanguagePage } from './settings/LanguagePage';
import { LOCALE_NAMES } from '../lib/i18n';
import { useLocale, useT } from '../hooks/useT';

/** The subpages, in the order they appear. */
type Section =
  | 'profile'
  | 'notifications'
  | 'calls'
  | 'privacy'
  | 'appearance'
  | 'language'
  | 'storage'
  | 'about'
  | 'account';

/** The page titles, as message keys — the strings themselves are looked up at
 *  render, so the header follows a language change without a remount. */
const TITLES: Record<Section, MessageKey> = {
  profile: 'settings.profile',
  notifications: 'settings.notifications',
  calls: 'settings.calls',
  privacy: 'settings.privacy',
  appearance: 'settings.appearance',
  language: 'settings.language',
  storage: 'settings.storage',
  about: 'settings.about',
  account: 'settings.accounts',
};

interface SettingsPanelProps {
  session: Session;
  profile: Profile;
  onUpdated: (profile: Profile) => void;
  /** Runs App.signOut, which tears down far more than the session. */
  onSignOut: () => void;
  /** The one instance owned by `App`. Calling `useAppLock` again here would
   *  build a second state machine and the gate would stop matching the toggle. */
  appLock: AppLock;
  /** Every account signed in on this device, current one included. */
  accounts: StoredAccount[];
  onSwitchAccount: (account: StoredAccount) => void;
  onForgetAccount: (account: StoredAccount) => void;
  onAddAccount: () => void;
}

/**
 * Everything under the cogwheel: a short list of destinations, and the page one
 * of them is showing.
 *
 * Split into subpages rather than one scroll because settings only ever grow. A
 * single page meant every new switch pushed the ones below it further out of
 * reach, and the reader had to scan past notification permissions to find the
 * account they wanted to switch to. Each page under `settings/` owns its own
 * state, so opening Storage costs a filesystem walk and opening anything else
 * costs nothing.
 *
 * Rendered as the phone's settings tab and inside `SettingsModal` on desktop —
 * one body, so a setting added here appears on both without being written twice.
 * `SettingsPage` claims the hardware back button for whichever page is open, and
 * history entries stack, so back walks page → settings → chats.
 */
export function SettingsPanel({
  session,
  profile,
  onUpdated,
  onSignOut,
  appLock,
  accounts,
  onSwitchAccount,
  onForgetAccount,
  onAddAccount,
}: SettingsPanelProps) {
  const [section, setSection] = useState<Section | null>(null);
  const t = useT();
  const locale = useLocale();

  if (section) {
    return (
      <SettingsPage title={t(TITLES[section])} onBack={() => setSection(null)}>
        {section === 'profile' && (
          <ProfilePage session={session} profile={profile} onUpdated={onUpdated} />
        )}
        {section === 'notifications' && <NotificationsPage />}
        {section === 'calls' && <CallsPage />}
        {section === 'privacy' && <PrivacyPage appLock={appLock} />}
        {section === 'appearance' && <AppearancePage />}
        {section === 'language' && <LanguagePage />}
        {section === 'storage' && <StoragePage />}
        {section === 'about' && <AboutPage />}
        {section === 'account' && (
          <AccountPage
            session={session}
            profile={profile}
            onSignOut={onSignOut}
            accounts={accounts}
            onSwitchAccount={onSwitchAccount}
            onForgetAccount={onForgetAccount}
            onAddAccount={onAddAccount}
          />
        )}
      </SettingsPage>
    );
  }

  const lockOn = appLock.state !== 'off' && appLock.state !== 'loading';

  return (
    <>
      {/* The profile is the one row worth a face rather than an icon: it is what
          the other person sees, and a 24-pixel cog would not show whether the
          avatar uploaded. */}
      <button
        type="button"
        className="w-full flex items-center gap-3 p-3 mb-4 rounded-box border border-base-content/10 bg-base-200/40 hover:bg-base-content/5 text-left"
        onClick={() => setSection('profile')}
      >
        <div className="avatar placeholder shrink-0">
          <div className="w-12 h-12 rounded-full bg-base-content/10 text-base-content/70 overflow-hidden ring ring-base-content/5">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-lg font-semibold">{initial(profile.display_name)}</span>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{profile.display_name}</p>
          <p className="text-xs text-base-content/60">{t('settings.profileHint')}</p>
        </div>
        <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
      </button>

      <Card>
        <NavRow
          icon={Bell}
          label={t('settings.notifications')}
          hint={t('settings.notificationsHint')}
          onClick={() => setSection('notifications')}
        />
        <NavRow
          icon={PhoneCall}
          label={t('settings.calls')}
          hint={t('settings.callsHint')}
          onClick={() => setSection('calls')}
        />
        <NavRow
          icon={Lock}
          label={t('settings.privacy')}
          hint={t('settings.privacyHint')}
          value={lockOn ? t('settings.privacyLocked') : undefined}
          onClick={() => setSection('privacy')}
        />
        <NavRow
          icon={Palette}
          label={t('settings.appearance')}
          hint={t('settings.appearanceHint')}
          onClick={() => setSection('appearance')}
        />
        <NavRow
          icon={Languages}
          label={t('settings.language')}
          hint={t('language.hint')}
          // The language in force, not the stored preference: somebody who
          // never chose one still wants to see what the app decided.
          value={LOCALE_NAMES[locale]}
          onClick={() => setSection('language')}
        />
        <NavRow
          icon={HardDrive}
          label={t('settings.storage')}
          hint={t('settings.storageHint')}
          onClick={() => setSection('storage')}
        />
      </Card>

      <Card>
        <NavRow
          icon={Users}
          label={t('settings.accounts')}
          hint={t('settings.accountsHint')}
          value={
            accounts.length > 1 ? t('settings.accountsHere', { count: accounts.length }) : undefined
          }
          onClick={() => setSection('account')}
        />
        <NavRow
          icon={Info}
          label={t('settings.about')}
          hint={t('settings.aboutHint')}
          value={APP_VERSION}
          onClick={() => setSection('about')}
        />
      </Card>
    </>
  );
}
