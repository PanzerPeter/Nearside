import { useEffect, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { supabase } from '../lib/supabase';
import { Profile, initial } from '../lib/types';
import {
  canRequestPushPermission,
  hasPushPermission,
  pushBlockedByOs,
  requestPushPermission,
  setPushEnabled,
} from '../lib/notifications';
import { AVATAR_MAX_EDGE, compressImage } from '../lib/compress';
import { isSoundMuted, setSoundMuted } from '../lib/sound';
import { confirmsUsername } from '../lib/account';
import { clearAll } from '../lib/outbox';
import { clearLocalDb } from '../lib/localdb';
import { clearPinnedMedia } from '../lib/pins';
import { clearSeed } from '../lib/keystore';
import { permissionSettingsLocation } from '../lib/device';
import { useToast } from '../hooks/useToast';
import { ServerView } from './ServerView';
import { ThemeStore } from './ThemeStore';
import { OpenSourceLicenses } from './OpenSourceLicenses';
import { SecurityLimits } from './SecurityLimits';
import { LegalDocModal, type LegalDoc } from './LegalFooter';
import { MIN_PASSPHRASE_LENGTH, type RelockAfter } from '../lib/app-lock';
import type { AppLock } from '../hooks/useAppLock';
import {
  Camera,
  Bell,
  ChevronRight,
  Database,
  FileText,
  Lock,
  LogOut,
  Palette,
  Scale,
  ShieldAlert,
  Volume2,
} from 'lucide-react';

/** Display names collide freely and keep their spaces and capitals; the only
 *  rule left is that there is one and that it fits. See 0022_display_name. */
const DISPLAY_NAME_MAX = 32;

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

interface SettingsPanelProps {
  session: Session;
  profile: Profile;
  onUpdated: (profile: Profile) => void;
  /** Runs App.signOut, which tears down far more than the session. */
  onSignOut: () => void;
  /** The one instance owned by `App`. Calling `useAppLock` again here would
   *  build a second state machine and the gate would stop matching the toggle. */
  appLock: AppLock;
}

/**
 * Everything under the cogwheel, as a plain block of content. Rendered as the
 * phone's settings tab and inside `SettingsModal` on desktop — one body, so a
 * setting added here appears on both without being written twice.
 *
 * It owns its own Save button rather than taking one from a modal footer: as a
 * page there is no footer to put it in, and a button that sits beside the field
 * it commits reads better in the dialog too.
 */
export function SettingsPanel({
  session,
  profile,
  onUpdated,
  onSignOut,
  appLock,
}: SettingsPanelProps) {
  const [display_name, setUsername] = useState(profile.display_name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? null);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [lockSetup, setLockSetup] = useState(false);
  const [lockPhrase, setLockPhrase] = useState('');
  const [lockRepeat, setLockRepeat] = useState('');
  const [lockError, setLockError] = useState('');

  async function saveAppLock() {
    if (lockPhrase !== lockRepeat) {
      setLockError('Those do not match.');
      return;
    }
    try {
      await appLock.enable(lockPhrase, appLock.relock);
      setLockPhrase('');
      setLockRepeat('');
      setLockError('');
      setLockSetup(false);
    } catch (e) {
      setLockError(e instanceof Error ? e.message : 'Could not set the lock.');
    }
  }

  // Whether the OS has granted notifications, as OneSignal reports it.
  // Deliberately NOT the WebView's `Notification.permission`: an Android
  // WebView has no `window.Notification` at all, so that check answered
  // "denied" on the one platform this app ships to and left the toggle
  // disabled under the words "Not supported on this device".
  const [granted, setGranted] = useState<boolean | null>(null);
  // Whether Android would still show its dialog. Android 13 stops offering it
  // after a dismissal, and from then on the toggle cannot do anything at all,
  // so this is what decides between "tap to turn on" and "go to system
  // settings". Saying the second while the first was true is what made the
  // toggle read as broken.
  const [canRequest, setCanRequest] = useState(true);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [muted, setMuted] = useState(isSoundMuted());
  const native = Capacitor.isNativePlatform();

  const [showServerView, setShowServerView] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);

  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Reflect whether this device is currently opted in with OneSignal.
  useEffect(() => {
    let active = true;
    void Promise.all([hasPushPermission(), canRequestPushPermission()]).then(([ok, askable]) => {
      if (!active) return;
      setGranted(ok);
      setPushOn(ok);
      setCanRequest(askable);
    });
    return () => {
      active = false;
    };
  }, []);

  async function toggleNotifications() {
    if (pushBusy) return;
    setPushBusy(true);
    if (pushOn) {
      await setPushEnabled(false);
      setPushOn(false);
      toast.success('Notifications turned off on this device.');
    } else {
      // Asked here, at the moment the user turns them on, and never at launch.
      const ok = await requestPushPermission();
      setGranted(ok);
      setPushOn(ok);
      if (ok) {
        await setPushEnabled(true);
        toast.success('Notifications on. They never carry message content.');
      } else {
        // A refusal and a dialog that never appeared need different advice, so
        // re-read whether Android is still willing to ask.
        const askable = await canRequestPushPermission();
        setCanRequest(askable);
        toast.error(
          askable
            ? 'Notifications stay off until you allow them.'
            : `Android is no longer asking. Turn them on in ${permissionSettingsLocation()}.`
        );
      }
    }
    setPushBusy(false);
  }

  function toggleSound() {
    const next = !muted;
    setMuted(next);
    setSoundMuted(next);
  }

  const notifStatus = !native
    ? 'Only the Android app can notify you in the background'
    : granted === null
      ? 'Checking…'
      : pushOn
        ? 'On. A notification names the sender and never what they said.'
        : granted
          ? 'Hear about messages while the app is closed'
          : pushBlockedByOs({ granted: false, canRequest })
            ? `Blocked by Android. Turn them on in ${permissionSettingsLocation()}.`
            : 'Tap to turn on. Android will ask you to allow it.';

  async function handleAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Avatar must be an image.');
      return;
    }
    setUploading(true);

    // An avatar is never painted above ~64 px, so the full camera resolution
    // is pure upload cost — and the 5 MB bucket limit would otherwise reject
    // an ordinary phone photo outright.
    const upload = await compressImage(file, { maxEdge: AVATAR_MAX_EDGE });
    const ext = upload.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `${session.user.id}/avatar.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, upload, { upsert: true, cacheControl: '3600', contentType: upload.type });

    if (uploadError) {
      setUploading(false);
      toast.error(uploadError.message);
      return;
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    const bustedUrl = `${data.publicUrl}?v=${Date.now()}`;

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ avatar_url: bustedUrl })
      .eq('id', session.user.id);

    setUploading(false);
    if (profileError) {
      toast.error(profileError.message);
      return;
    }
    setAvatarUrl(bustedUrl);
    // Only the avatar was saved. Publishing `display_name` here would push the
    // half-typed input up to the app shell as though it had been committed.
    onUpdated({ ...profile, avatar_url: bustedUrl });
    toast.success('Avatar updated.');
  }

  const nameChanged = display_name.trim() !== profile.display_name;

  async function handleSaveUsername() {
    // Not lowercased: capitals are the user's to choose now.
    const normalized = display_name.trim();
    if (normalized === profile.display_name) return;
    if (!normalized || normalized.length > DISPLAY_NAME_MAX) {
      toast.error(`Enter a display name, up to ${DISPLAY_NAME_MAX} characters.`);
      return;
    }
    setSaving(true);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ display_name: normalized })
      .eq('id', session.user.id);
    setSaving(false);

    if (updateError) {
      toast.error(
        /duplicate|unique/i.test(updateError.message)
          ? 'That name could not be saved.'
          : updateError.message
      );
      return;
    }
    onUpdated({ ...profile, display_name: normalized, avatar_url: avatarUrl });
    toast.success('Display name updated.');
  }

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
      <div className="flex flex-col items-center gap-3 mb-5">
        <button
          type="button"
          className="relative group"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Change avatar"
        >
          <div className="avatar placeholder">
            <div className="w-20 h-20 rounded-full bg-base-content/10 text-base-content/70 overflow-hidden ring ring-base-content/5">
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
              ) : (
                <span className="text-2xl font-semibold">{initial(display_name)}</span>
              )}
            </div>
          </div>
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-neutral/60 opacity-0 group-hover:opacity-100 transition-opacity">
            {uploading ? (
              <span className="loading loading-spinner loading-sm text-neutral-content" />
            ) : (
              <Camera className="w-5 h-5 text-neutral-content" />
            )}
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatar} />
        <p className="text-xs text-base-content/60">Tap the photo to upload an avatar</p>
      </div>

      <div className="form-control">
        <label className="label pb-1">
          <span className="label-text text-xs font-medium uppercase tracking-wider text-base-content/60">
            Display name
          </span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="input flex-1 min-w-0 bg-base-200/50 border border-base-content/10 focus:border-primary"
            value={display_name}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={DISPLAY_NAME_MAX}
          />
          <button
            className="btn btn-primary shrink-0"
            onClick={handleSaveUsername}
            disabled={saving || !nameChanged}
          >
            {saving ? <span className="loading loading-spinner loading-sm" /> : 'Save'}
          </button>
        </div>
        <span className="text-xs text-base-content/60 mt-1">
          Shown to friends in chats. Spaces and capitals are fine, and two people may pick the same
          name. A display name is not an address, and nobody can find you by it.
        </span>
      </div>

      <div className="divider my-4" />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Bell className="w-4 h-4 text-base-content/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Message notifications</p>
              {/* Not truncated. This line is the only place the app says where
                  to go when Android has blocked notifications, and clipping it
                  at "enable them in Android's…" is how it read before. */}
              <p className="text-xs text-base-content/60">{notifStatus}</p>
            </div>
          </div>
          {pushBusy ? (
            <span className="loading loading-spinner loading-sm shrink-0" />
          ) : (
            <input
              type="checkbox"
              className="toggle toggle-primary shrink-0"
              checked={pushOn}
              onChange={toggleNotifications}
              disabled={!native}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Volume2 className="w-4 h-4 text-base-content/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Notification sound</p>
              <p className="text-xs text-base-content/60 truncate">Play a chime for new messages</p>
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary shrink-0"
            checked={!muted}
            onChange={toggleSound}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Lock className="w-4 h-4 text-base-content/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">App lock</p>
              <p className="text-xs text-base-content/60">
                Ask for a passphrase before opening Nearside
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary shrink-0"
            checked={appLock.state !== 'off' && appLock.state !== 'loading'}
            onChange={(e) => {
              if (e.target.checked) setLockSetup(true);
              else void appLock.disable();
            }}
          />
        </div>

        {lockSetup && appLock.state === 'off' && (
          <div className="rounded-box bg-base-200/60 p-3 space-y-2.5">
            <p className="text-xs text-base-content/70">
              This locks the app. It is not extra encryption — your key already sits in Android's
              Keystore and your messages are already encrypted on this phone. What it stops is
              someone picking up an unlocked phone and reading your conversations.
            </p>
            <p className="text-xs text-base-content/70">
              There is no way to reset it. Forgetting it means signing out, which keeps your account
              and your recovery phrase but clears the messages stored on this phone.
            </p>
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              placeholder={`Passphrase, at least ${MIN_PASSPHRASE_LENGTH} characters`}
              value={lockPhrase}
              onChange={(e) => {
                setLockPhrase(e.target.value);
                setLockError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <input
              type="password"
              className="input input-bordered input-sm w-full"
              placeholder="Again"
              value={lockRepeat}
              onChange={(e) => {
                setLockRepeat(e.target.value);
                setLockError('');
              }}
              autoCapitalize="none"
              autoCorrect="off"
            />
            {lockError && <p className="text-xs text-error">{lockError}</p>}
            <div className="flex gap-2">
              <button
                className="btn btn-primary btn-sm flex-1"
                disabled={lockPhrase.length < MIN_PASSPHRASE_LENGTH}
                onClick={() => void saveAppLock()}
              >
                Turn on
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setLockSetup(false);
                  setLockPhrase('');
                  setLockRepeat('');
                  setLockError('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {appLock.state !== 'off' && appLock.state !== 'loading' && (
          <label className="flex items-center justify-between gap-3 pl-6.5">
            <span className="text-xs text-base-content/60">Lock after</span>
            <select
              className="select select-bordered select-sm"
              value={appLock.relock}
              onChange={(e) => void appLock.setRelock(e.target.value as RelockAfter)}
            >
              <option value="immediate">Leaving the app</option>
              <option value="1m">1 minute</option>
              <option value="5m">5 minutes</option>
            </select>
          </label>
        )}
      </div>

      <div className="divider my-4" />

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-base-content/60">
          Appearance
        </p>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setShowThemes(true)}
        >
          <Palette className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Themes</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
      </div>

      <div className="divider my-4" />

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-base-content/60">Privacy</p>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setShowServerView(true)}
        >
          <Database className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">What the server knows</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setShowLimits(true)}
        >
          <ShieldAlert className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Where this protection stops</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setShowLicenses(true)}
        >
          <Scale className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Open source licenses</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
      </div>

      <div className="divider my-4" />

      {/* The documents used to be reachable only from the sign-in screen's
          footer, which a signed-in user never sees again. */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-base-content/60">Legal</p>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setLegalDoc('terms')}
        >
          <FileText className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Terms of Service</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
        <button
          className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
          onClick={() => setLegalDoc('privacy')}
        >
          <Lock className="w-4 h-4 text-base-content/60 shrink-0" />
          <span className="flex-1 text-left">Privacy Policy</span>
          <ChevronRight className="w-4 h-4 text-base-content/40 shrink-0" />
        </button>
      </div>

      <div className="divider my-4" />

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-base-content/60">Account</p>
        {confirmingSignOut ? (
          <>
            {/* Confirmed rather than one-tap, which is what it was in the top
                bar: signing out drops queued-but-unsent messages and this
                account's decrypted mirror, so search and previews are rebuilt
                from scratch afterwards. Nothing sent is lost. */}
            <p className="text-xs text-base-content/60">
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
          </>
        ) : (
          <button
            className="btn btn-ghost btn-sm w-full justify-start gap-2.5 px-2"
            onClick={() => setConfirmingSignOut(true)}
          >
            <LogOut className="w-4 h-4 text-base-content/60 shrink-0" />
            <span className="flex-1 text-left">Sign out</span>
          </button>
        )}
      </div>

      <div className="divider my-4" />

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-error">Danger zone</p>
        {confirmingDelete ? (
          <>
            <p className="text-xs text-base-content/60">
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
                onClick={handleDeleteAccount}
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
            <p className="text-xs text-base-content/60">
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

      {showServerView && (
        <ServerView
          onClose={() => setShowServerView(false)}
          onOpenLimits={() => {
            setShowServerView(false);
            setShowLimits(true);
          }}
        />
      )}
      {showLimits && <SecurityLimits onClose={() => setShowLimits(false)} />}
      {showThemes && <ThemeStore onClose={() => setShowThemes(false)} />}
      {showLicenses && <OpenSourceLicenses onClose={() => setShowLicenses(false)} />}
      {legalDoc && <LegalDocModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </>
  );
}
