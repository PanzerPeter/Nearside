import { useCallback, useEffect, useState } from 'react';
import { Pencil, ShieldAlert, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';
import type { VerificationState } from '../lib/verification';
import type { PresenceStatus } from '../lib/presence-model';
import { formatLastSeen } from '../lib/time';
import { Avatar } from './Avatar';
import { Modal } from './Modal';
import { StatusDot, presenceLabels } from './StatusDot';
import { useT } from '../hooks/useT';

interface ProfileCardProps {
  /** Whose profile this is. The card fetches by id rather than trusting the
   *  row it was handed: the friend list's copy can be minutes old, and a bio
   *  that has been rewritten since is worse than one that takes a beat. */
  userId: string;
  /** The row already in hand, shown while the fetch is in flight so the card
   *  never opens empty. */
  fallback: Profile;
  /** The private name this user gave them, or null. Not part of the profile —
   *  it is a row in `friend_nicknames` that only the person who wrote it can
   *  read, which is why it is displayed apart from the name below. */
  nickname: string | null;
  isSelf: boolean;
  trust: VerificationState;
  friendStatus: PresenceStatus;
  /** Opens the nickname editor. Absent for the self-chat, which is named
   *  rather than nicknamed. */
  onEditNickname: () => void;
  onClose: () => void;
}

/**
 * Who somebody is, from the chat header's avatar.
 *
 * Read-only, deliberately. Verifying, muting and the conversation's own
 * settings already live in the header's ⋮ menu, and a second door to each of
 * them is a second place to keep in step. The one exception is the nickname,
 * because a nickname is a fact about the person rather than about the chat, and
 * this card is the only screen where the name they chose and the name you gave
 * them are both visible at once.
 *
 * It carries no explanation of how any of it is stored. What a bio costs in
 * privacy is a paragraph, and a paragraph belongs in the privacy policy and on
 * the transparency screen, both of which are two taps away and both of which
 * are written for somebody who came to read them.
 */
export function ProfileCard({
  userId,
  fallback,
  nickname,
  isSelf,
  trust,
  friendStatus,
  onEditNickname,
  onClose,
}: ProfileCardProps) {
  const t = useT();
  const [profile, setProfile] = useState<Profile>(fallback);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** The avatar, full-screen. A profile picture is the one image in the app
   *  that is never an attachment, so it does not go through MediaLightbox —
   *  there is no per-file key to open, nothing to pin and nothing to save. */
  const [zoomed, setZoomed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, avatar_url, bio, last_seen_at')
      .eq('id', userId)
      .maybeSingle();
    setLoading(false);
    // A row that will not load is a failure worth naming: the RLS policy only
    // returns profiles you are connected to, so an empty answer here means the
    // friendship is gone as often as it means the network is.
    if (error || !data) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setProfile(data as Profile);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const bio = profile.bio?.trim();

  return (
    <Modal title={t('profileCard.title')} onClose={onClose}>
      <div className="flex flex-col items-center gap-3 text-center">
        <button
          type="button"
          onClick={() => setZoomed(true)}
          disabled={!profile.avatar_url}
          title={profile.avatar_url ? t('profileCard.viewPhoto') : undefined}
          className="rounded-full ring ring-base-content/5 disabled:cursor-default"
        >
          <Avatar display_name={profile.display_name} url={profile.avatar_url} size={96} />
        </button>

        <div className="min-w-0">
          <p className="text-lg font-semibold break-words">{profile.display_name}</p>
          {/* Presence, not a second copy of the header's status line: the
              header is behind this card and cannot be read while it is open. */}
          <p className="mt-0.5 flex items-center justify-center gap-1.5 text-xs text-base-content/60">
            {isSelf ? (
              <span>{t('chat.onlyYou')}</span>
            ) : (
              <>
                <StatusDot status={friendStatus} size={8} />
                {friendStatus === 'offline' && profile.last_seen_at
                  ? formatLastSeen(profile.last_seen_at)
                  : t(presenceLabels[friendStatus])}
              </>
            )}
          </p>
        </div>

        {!isSelf && trust !== 'unverified' && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              trust === 'verified' ? 'bg-success/15 text-success' : 'bg-error/15 text-error'
            }`}
          >
            {trust === 'verified' ? (
              <ShieldCheck className="w-3.5 h-3.5" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5" />
            )}
            {trust === 'verified' ? t('chat.verified') : t('chat.keyChanged')}
          </span>
        )}
      </div>

      <div className="mt-5 space-y-4">
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wider text-base-content/60">
            {t('profileCard.bio')}
          </h4>
          {failed ? (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-sm text-base-content/60">{t('profileCard.loadFailed')}</p>
              <button className="btn btn-xs btn-ghost" onClick={() => void load()}>
                {t('rail.tryNow')}
              </button>
            </div>
          ) : loading && bio === undefined ? (
            <span className="loading loading-dots loading-sm mt-1 text-base-content/40" />
          ) : bio ? (
            // Pre-wrapped: newlines are the one thing a bio keeps that a
            // display name does not, so they have to survive the render too.
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{bio}</p>
          ) : (
            <p className="mt-1 text-sm italic text-base-content/50">
              {isSelf ? t('profileCard.bioEmptySelf') : t('profileCard.bioEmpty')}
            </p>
          )}
        </section>

        {!isSelf && (
          <section>
            <h4 className="text-xs font-medium uppercase tracking-wider text-base-content/60">
              {t('profileCard.yourNameFor')}
            </h4>
            <div className="mt-1 flex items-center gap-2">
              <p className={`flex-1 truncate text-sm ${nickname ? '' : 'italic text-base-content/50'}`}>
                {nickname ?? t('profileCard.noNickname')}
              </p>
              <button
                className="btn btn-xs btn-ghost gap-1"
                onClick={() => {
                  // The editor is a modal too, and two <dialog>s open at once
                  // leave the top one's Escape closing the wrong screen.
                  onClose();
                  onEditNickname();
                }}
              >
                <Pencil className="w-3 h-3" />
                {nickname ? t('profileCard.changeNickname') : t('profileCard.setNickname')}
              </button>
            </div>
            <p className="mt-1 text-xs text-base-content/50">{t('profileCard.nicknameNote')}</p>
          </section>
        )}

        {isSelf && <p className="text-xs text-base-content/50">{t('profileCard.selfHint')}</p>}
      </div>

      {zoomed && profile.avatar_url && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95 p-6"
          onClick={() => setZoomed(false)}
        >
          <img
            src={profile.avatar_url}
            alt=""
            className="max-h-[80dvh] max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </Modal>
  );
}
