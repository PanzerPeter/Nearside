import { useEffect, useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Profile, initial } from '../lib/types';
import {
  enablePush,
  disablePush,
  notificationPermission,
  notificationsSupported,
  pushSupported,
} from '../lib/push';
import { AVATAR_MAX_EDGE, compressImage } from '../lib/compress';
import { isSoundMuted, setSoundMuted } from '../lib/sound';
import { confirmsUsername } from '../lib/account';
import { clearAll } from '../lib/outbox';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { Camera, Bell, Volume2 } from 'lucide-react';

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

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

interface SettingsModalProps {
  session: Session;
  profile: Profile;
  onUpdated: (profile: Profile) => void;
  onClose: () => void;
}

export function SettingsModal({ session, profile, onUpdated, onClose }: SettingsModalProps) {
  const [username, setUsername] = useState(profile.username);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? null);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [perm, setPerm] = useState<NotificationPermission>(notificationPermission());
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [muted, setMuted] = useState(isSoundMuted());

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Reflect whether this device currently holds a push subscription.
  useEffect(() => {
    let active = true;
    if (pushSupported() && notificationPermission() === 'granted') {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.pushManager.getSubscription())
        .then((sub) => {
          if (active) setPushOn(!!sub);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  async function toggleNotifications() {
    if (pushBusy) return;
    setPushBusy(true);
    if (pushOn) {
      await disablePush();
      setPushOn(false);
      toast.success('Notifications turned off on this device.');
    } else {
      const { permission, subscribed } = await enablePush(session);
      setPerm(permission);
      setPushOn(subscribed);
      if (subscribed) {
        toast.success('Notifications enabled.');
      } else if (permission === 'denied') {
        toast.error('Notifications are blocked. Enable them in your browser settings.');
      } else {
        // Permission granted but no subscription — Push isn't available here.
        toast.error(
          'This browser can’t deliver background notifications. Add Nearside to your home screen, or keep the app open to be notified.'
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

  const notifStatus = !notificationsSupported()
    ? 'Not supported on this browser'
    : !pushSupported()
      ? 'Background push unavailable on this browser'
      : perm === 'denied'
        ? 'Blocked in browser settings'
        : pushOn
          ? 'On for this device'
          : 'Get notified even when the app is closed';

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
    // Only the avatar was saved. Publishing `username` here would push the
    // half-typed input up to the app shell as though it had been committed.
    onUpdated({ ...profile, avatar_url: bustedUrl });
    toast.success('Avatar updated.');
  }

  async function handleSaveUsername() {
    const normalized = username.trim().toLowerCase();
    if (normalized === profile.username) {
      onClose();
      return;
    }
    if (!USERNAME_RE.test(normalized)) {
      toast.error('Username must be 3–24 characters: letters, numbers, or underscores.');
      return;
    }
    setSaving(true);
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ username: normalized })
      .eq('id', session.user.id);
    setSaving(false);

    if (updateError) {
      toast.error(
        /duplicate|unique/i.test(updateError.message)
          ? 'That username is already taken.'
          : updateError.message
      );
      return;
    }
    onUpdated({ ...profile, username: normalized, avatar_url: avatarUrl });
    toast.success('Username updated.');
  }

  async function handleDeleteAccount() {
    // Re-checked here and not only on the button's `disabled`: the gate is the
    // whole point of this flow, and a disabled attribute is a hint, not a lock.
    if (deleting || !confirmsUsername(deleteText, profile.username)) return;
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
      // "delete my account" has to mean them too.
      await clearAll();
      await supabase.auth.signOut();
    } finally {
      window.location.reload();
    }
  }

  return (
    <Modal
      title="Profile settings"
      onClose={onClose}
      className="max-w-md"
      actions={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={handleSaveUsername} disabled={saving}>
            {saving ? <span className="loading loading-spinner loading-sm" /> : 'Save'}
          </button>
        </>
      }
    >
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
                <span className="text-2xl font-semibold">{initial(username)}</span>
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
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleAvatar}
        />
        <p className="text-xs text-base-content/60">Tap the photo to upload an avatar</p>
      </div>

      <div className="form-control">
        <label className="label pb-1">
          <span className="label-text text-xs font-medium uppercase tracking-wider text-base-content/60">
            Username
          </span>
        </label>
        <input
          type="text"
          className="input w-full bg-base-200/50 border border-base-content/10 focus:border-primary"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          minLength={3}
          maxLength={24}
          pattern="[a-zA-Z0-9_]+"
        />
        <span className="text-xs text-base-content/60 mt-1">
          Shown to friends in chats. Letters, numbers, underscores.
        </span>
      </div>

      <div className="divider my-4" />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Bell className="w-4 h-4 text-base-content/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Message notifications</p>
              <p className="text-xs text-base-content/60 truncate">{notifStatus}</p>
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
              disabled={!pushSupported() || perm === 'denied'}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Volume2 className="w-4 h-4 text-base-content/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Notification sound</p>
              <p className="text-xs text-base-content/60 truncate">
                Play a chime for new messages
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle toggle-primary shrink-0"
            checked={!muted}
            onChange={toggleSound}
          />
        </div>
      </div>

      <div className="divider my-4" />

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wider text-error">Danger zone</p>
        {confirmingDelete ? (
          <>
            <p className="text-xs text-base-content/60">
              Type <span className="font-medium text-base-content/80">{profile.username}</span> to
              confirm. This cannot be undone.
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
              aria-label="Type your username to confirm deletion"
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
                disabled={deleting || !confirmsUsername(deleteText, profile.username)}
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
    </Modal>
  );
}
