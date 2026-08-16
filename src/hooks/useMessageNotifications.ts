import { useEffect, useRef } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import { playNotificationSound } from '../lib/sound';
import { AlertAnchor, clearAlert, noteAlert } from '../lib/alert-throttle';
import { isMobileNative } from '../lib/platform';
import { notificationPermission } from '../lib/notifications';
import { advanceDelivered } from '../lib/receipts';
import { useConnection } from '../lib/connection';
import { nicknameFor } from '../lib/nicknames';

// Short-lived so a rename shows up promptly, but still long enough to spare a
// lookup on each message of a burst. An unbounded cache pinned the old handle
// for the entire session.
const USERNAME_TTL_MS = 5 * 60 * 1000;

/**
 * App-wide listener for incoming direct messages. While the app is open (any
 * tab or the installed PWA) it plays a sound and shows a notification for
 * messages from ANY friend — not just the currently open chat.
 *
 * Suppression, in three layers:
 *
 *   - nothing at all when the message belongs to the chat you're already
 *     looking at AND the window is focused; you watched it arrive.
 *   - no chime on a phone. OneSignal owns the tray entry and its channel owns
 *     the sound there, so this path playing one as well is the same message
 *     making two different noises.
 *   - a chime on the ladder in `alert-throttle.ts`: the first message rings at
 *     once, the next two while the burst is still happening, and after that one
 *     every forty seconds. The banner still appears for every message; it is
 *     the sound that is not worth repeating while somebody finishes a thought.
 *     Opening a chat clears its streak, so the reply that follows you putting
 *     the phone down rings like a first message. `send-push` applies the same
 *     ladder to the notification a closed app receives.
 *
 * Background push (app closed) is handled separately by the service worker.
 */
export function useMessageNotifications(
  session: Session | null,
  activeFriendId: string | null
) {
  // Keep the latest active chat id without re-subscribing the realtime channel.
  const activeRef = useRef<string | null>(activeFriendId);
  activeRef.current = activeFriendId;
  // Rebuild this channel after a wake — a dead one notifies about nothing.
  const { generation } = useConnection();

  const usernameCache = useRef<Map<string, { name: string; at: number }>>(new Map());

  // When each sender last made a sound, and how many times in a row. Outlives
  // the channel rebuild a wake causes — a fresh map there would let one
  // reconnect re-open every conversation's budget, which is exactly when a
  // backlog arrives at once.
  const alertAnchors = useRef<Map<string, AlertAnchor>>(new Map());

  // Opening a conversation is this path's read watermark: you have seen what we
  // rang about, so the ladder starts over and the next message that arrives
  // while you are elsewhere is heard at once. The server does the same thing
  // from `message_receipts.read_at`, which is the only copy it can check.
  useEffect(() => {
    if (activeFriendId) clearAlert(alertAnchors.current, activeFriendId);
  }, [activeFriendId]);

  useEffect(() => {
    if (!session) return;
    const me = session.user.id;

    async function resolveDisplayName(userId: string): Promise<string> {
      const cached = usernameCache.current.get(userId);
      if (cached && Date.now() - cached.at < USERNAME_TTL_MS) return cached.name;
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('id', userId)
        .maybeSingle();
      // On a failed lookup prefer a stale name over the "someone" placeholder,
      // and don't cache the failure.
      if (error || !data?.display_name) return cached?.name ?? 'someone';
      usernameCache.current.set(userId, { name: data.display_name, at: Date.now() });
      return data.display_name;
    }

    async function showNotification(title: string, body: string, tag: string) {
      if (notificationPermission() !== 'granted') return;
      const options: NotificationOptions = {
        body,
        tag,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        data: { url: '/' },
      };
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
          await reg.showNotification(title, options);
          return;
        }
      } catch {
        /* fall through to the constructor */
      }
      try {
        new Notification(title, options);
      } catch {
        /* notifications unavailable */
      }
    }

    async function handleIncoming(msg: Message) {
      if (msg.user_id === me || msg.deleted_at) return;

      // This client has the message in hand — that is exactly what the
      // sender's second tick claims, so record it before anything else.
      void advanceDelivered(msg.user_id, msg.created_at);

      const focusedOnThisChat =
        document.visibilityState === 'visible' &&
        document.hasFocus() &&
        activeRef.current === msg.user_id;
      if (focusedOnThisChat) return;

      if (!isMobileNative() && noteAlert(alertAnchors.current, msg.user_id, Date.now())) {
        playNotificationSound();
      }

      // The nickname you gave them, if you gave them one — a banner that says
      // "Bobby" while the app says "Bobby" is the point of the feature. Read
      // from the store rather than fetched: it is already loaded and live.
      const title = nicknameFor(msg.user_id) ?? `@${await resolveDisplayName(msg.user_id)}`;
      // The body is sealed and this hook holds no key, so a banner can name the
      // kind of thing that arrived but never quote it. Previewing text would
      // mean decrypting here — a second place that opens bodies, on a code path
      // that also runs on the lock screen. Naming the sender is the useful part
      // and it costs nothing.
      const body =
        msg.media_type === 'image'
          ? '📷 Photo'
          : msg.media_type === 'video'
            ? '🎥 Video'
            : msg.media_type === 'audio'
              ? '🎤 Voice message'
              : msg.media_type === 'sticker'
                ? '🩷 Sticker'
                : 'New message';
      await showNotification(title, body, `dm:${msg.user_id}`);
    }

    const channel = supabase
      .channel(`notify:${me}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `receiver_id=eq.${me}`,
        },
        (payload) => {
          handleIncoming(payload.new as Message);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, generation]);
}
