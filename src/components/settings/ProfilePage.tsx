import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { DISPLAY_NAME_MAX } from '../../lib/profile-shape';
import { updateOwnProfile } from '../../lib/profile-seal';
import { Profile, initial } from '../../lib/types';
import { AVATAR_MAX_EDGE, compressImage } from '../../lib/compress';
import { MAX_BIO_LENGTH, bioLength, normalizeBio } from '../../lib/bio';
import { useToast } from '../../hooks/useToast';
import { AvatarCropper } from '../AvatarCropper';
import { useT } from '../../hooks/useT';


interface ProfilePageProps {
  profile: Profile;
  onUpdated: (profile: Profile) => void;
}

/**
 * What other people see: the photo, the name, and the line about yourself.
 *
 * It owns its own Save button rather than taking one from a modal footer — as a
 * page there is no footer to put it in, and a button beside the field it commits
 * reads better in the dialog too.
 */
export function ProfilePage({ profile, onUpdated }: ProfilePageProps) {
  const [display_name, setUsername] = useState(profile.display_name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? null);
  const [bio, setBio] = useState(profile.bio ?? '');
  const [savingBio, setSavingBio] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** A picked photo waiting to be framed. */
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const t = useT();

  // Framing happens before the upload, so a picked photo waits here for the
  // cropper rather than going straight up centred.
  function handleAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.avatarMustBeImage'));
      return;
    }
    setPendingAvatar(file);
  }

  async function uploadAvatar(file: File) {
    setUploading(true);

    // An avatar is never painted above ~64 px, so the full camera resolution
    // is pure upload cost — and the 5 MB bucket limit would otherwise reject
    // an ordinary phone photo outright. The cropper already caps its output,
    // so this is a no-op on that path and the guard for the fallbacks.
    const upload = await compressImage(file, { maxEdge: AVATAR_MAX_EDGE });
    try {
      // Sealed under the profile key and uploaded as opaque bytes (0061): the
      // bucket is public, and a public URL to a face was the one thing in the
      // app anybody could open without being anybody's contact.
      const saved = await updateOwnProfile(
        { display_name: profile.display_name, bio: profile.bio },
        { avatar: upload }
      );
      setAvatarUrl(saved.avatar_url);
      // Only the avatar was saved. Publishing `display_name` here would push
      // the half-typed input up to the app shell as though it had been
      // committed.
      onUpdated({ ...profile, avatar_url: saved.avatar_url });
      toast.success(t('profile.avatarUpdated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('profile.avatarFailed'));
    } finally {
      setUploading(false);
    }
  }

  const nameChanged = display_name.trim() !== profile.display_name;

  async function handleSaveUsername() {
    // Not lowercased: capitals are the user's to choose now.
    const normalized = display_name.trim();
    if (normalized === profile.display_name) return;
    if (!normalized || normalized.length > DISPLAY_NAME_MAX) {
      toast.error(t('profile.nameTooLong', { count: DISPLAY_NAME_MAX }));
      return;
    }
    setSaving(true);
    try {
      await updateOwnProfile(
        { display_name: profile.display_name, bio: profile.bio },
        { display_name: normalized }
      );
    } catch {
      toast.error(t('profile.nameNotSaved'));
      return;
    } finally {
      setSaving(false);
    }
    onUpdated({ ...profile, display_name: normalized, avatar_url: avatarUrl });
    toast.success(t('profile.nameUpdated'));
  }

  // Compared against what would be stored rather than against the raw field,
  // so trailing whitespace does not arm the Save button on a bio that has not
  // actually changed.
  const normalizedBio = normalizeBio(bio);
  const bioChanged = (normalizedBio ?? null) !== (profile.bio ?? null);

  async function handleSaveBio() {
    if (!bioChanged) return;
    setSavingBio(true);
    try {
      await updateOwnProfile(
        { display_name: profile.display_name, bio: profile.bio },
        { bio: normalizedBio }
      );
    } catch {
      toast.error(t('profile.bioNotSaved'));
      return;
    } finally {
      setSavingBio(false);
    }
    onUpdated({ ...profile, bio: normalizedBio, avatar_url: avatarUrl });
    toast.success(t('profile.bioUpdated'));
  }

  return (
    <>
      <div className="flex flex-col items-center gap-3 mb-5">
        <button
          type="button"
          className="relative group"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t('profile.changeAvatar')}
        >
          <div className="avatar placeholder">
            <div className="brand-gradient w-24 h-24 rounded-full text-primary-content overflow-hidden ring-3 ring-base-content/5">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={t('profile.avatarAlt')}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-3xl font-semibold">{initial(display_name)}</span>
              )}
            </div>
          </div>
          {/* A phone has no hover, so an upload would otherwise show nothing
              at all while it runs. */}
          <span
            className={`absolute inset-0 flex items-center justify-center rounded-full bg-neutral/60 transition-opacity ${
              uploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
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
        <p className="text-meta text-muted">{t('profile.tapPhoto')}</p>
      </div>

      <div className="flex flex-col">
        <label className="flex select-none items-center justify-between pb-1">
          <span className="text-meta font-medium text-muted">
            {t('profile.displayName')}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="input flex-1 min-w-0 bg-base-200/50 border border-hairline focus:border-primary"
            value={display_name}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={DISPLAY_NAME_MAX}
          />
          <button
            className="btn btn-primary shrink-0"
            onClick={handleSaveUsername}
            disabled={saving || !nameChanged}
          >
            {saving ? <span className="loading loading-spinner loading-sm" /> : t('common.save')}
          </button>
        </div>
        <span className="text-meta text-muted mt-1">{t('profile.displayNameNote')}</span>
      </div>

      <div className="flex flex-col mt-4">
        <label className="flex select-none items-center justify-between pb-1">
          <span className="text-meta font-medium text-muted">
            {t('profile.bio')}
          </span>
        </label>
        <textarea
          className="textarea min-h-24 w-full bg-base-200/50 border border-hairline focus:border-primary"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t('profile.bioPlaceholder')}
          // Capped here as well as in `normalizeBio`, so typing stops at the
          // limit instead of silently losing the tail on save.
          maxLength={MAX_BIO_LENGTH}
        />
        <div className="mt-1 flex items-start gap-2">
          <span className="flex-1 text-meta text-muted">{t('profile.bioNote')}</span>
          <span className="shrink-0 text-meta tabular-nums text-subtle">
            {bioLength(bio)}/{MAX_BIO_LENGTH}
          </span>
        </div>
        <button
          className="btn btn-primary btn-sm mt-2 self-end"
          onClick={handleSaveBio}
          disabled={savingBio || !bioChanged}
        >
          {savingBio ? <span className="loading loading-spinner loading-xs" /> : t('common.save')}
        </button>
      </div>

      {pendingAvatar && (
        <AvatarCropper
          file={pendingAvatar}
          onCancel={() => setPendingAvatar(null)}
          onCropped={(cropped) => {
            setPendingAvatar(null);
            void uploadAvatar(cropped);
          }}
        />
      )}
    </>
  );
}
