import { useRef, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { Camera } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Profile, initial } from '../../lib/types';
import { AVATAR_MAX_EDGE, compressImage } from '../../lib/compress';
import { useToast } from '../../hooks/useToast';
import { AvatarCropper } from '../AvatarCropper';
import { useT } from '../../hooks/useT';

/** Display names collide freely and keep their spaces and capitals; the only
 *  rule left is that there is one and that it fits. See 0022_display_name. */
const DISPLAY_NAME_MAX = 32;

interface ProfilePageProps {
  session: Session;
  profile: Profile;
  onUpdated: (profile: Profile) => void;
}

/**
 * The two things other people see: the photo and the name.
 *
 * It owns its own Save button rather than taking one from a modal footer — as a
 * page there is no footer to put it in, and a button beside the field it commits
 * reads better in the dialog too.
 */
export function ProfilePage({ session, profile, onUpdated }: ProfilePageProps) {
  const [display_name, setUsername] = useState(profile.display_name);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? null);
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
    const ext = upload.name.split('.').pop()?.toLowerCase() || 'png';
    const path = `${session.user.id}/avatar.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      // A year, because the URL written to `profiles.avatar_url` below carries
      // a `?v=` stamped at upload time: a replacement avatar is a different URL
      // and can never be served from a cache holding the old one. An hour meant
      // every device re-downloaded every avatar it had already seen, hourly,
      // for no possible correctness gain.
      .upload(path, upload, {
        upsert: true,
        cacheControl: '31536000',
        contentType: upload.type,
      });

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
    toast.success(t('profile.avatarUpdated'));
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
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ display_name: normalized })
      .eq('id', session.user.id);
    setSaving(false);

    if (updateError) {
      toast.error(
        /duplicate|unique/i.test(updateError.message)
          ? t('profile.nameNotSaved')
          : updateError.message,
      );
      return;
    }
    onUpdated({ ...profile, display_name: normalized, avatar_url: avatarUrl });
    toast.success(t('profile.nameUpdated'));
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
            <div className="w-24 h-24 rounded-full bg-base-content/10 text-base-content/70 overflow-hidden ring ring-base-content/5">
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" className="w-full h-full object-cover" />
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
        <p className="text-xs text-base-content/60">{t('profile.tapPhoto')}</p>
      </div>

      <div className="form-control">
        <label className="label pb-1">
          <span className="label-text text-xs font-medium uppercase tracking-wider text-base-content/60">
            {t('profile.displayName')}
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
            {saving ? <span className="loading loading-spinner loading-sm" /> : t('common.save')}
          </button>
        </div>
        <span className="text-xs text-base-content/60 mt-1">{t('profile.displayNameNote')}</span>
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
