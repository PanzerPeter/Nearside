import { useEffect, useRef } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { Message } from '../lib/types';
import { playNotificationSound } from '../lib/sound';
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
 * Suppression: stays silent when the message belongs to the chat you're already
 * looking at AND the window is focused (you can already see it arrive live).
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

      playNotificationSound();

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
