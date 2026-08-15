package app.nearside;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import java.util.ArrayDeque;

/**
 * The two notifications a call posts, in one place.
 *
 * Both the plugin (app already running) and the OneSignal extension (push woke
 * the phone) need to raise the same ring, and they run in different processes'
 * worth of context. A single builder here is what keeps the lock-screen ring
 * identical whichever path produced it.
 */
final class CallNotifications {

    /**
     * Channel ids carry a version suffix on purpose.
     *
     * Android refuses to change a channel it has already created — importance,
     * sound and vibration are frozen at creation on the device. `send-push`
     * learned the same lesson (see its ANDROID_CHANNEL_ID note): changing what
     * a channel does means a new id, and devices keep the old one until the app
     * is reinstalled.
     */
    static final String CHANNEL_INCOMING = "nearside_call_incoming_v1";
    static final String CHANNEL_ONGOING = "nearside_call_ongoing_v1";

    static final int RING_ID = 5001;
    static final int ONGOING_ID = 5002;

    static final String EXTRA_CALL_ID = "app.nearside.CALL_ID";
    static final String EXTRA_PEER_ID = "app.nearside.PEER_ID";
    static final String EXTRA_ACTION = "app.nearside.CALL_ACTION";
    /**
     * Voice or video, carried through to the WebView.
     *
     * The offer settles this, and the offer arrives seconds after a lock-screen
     * Answer on a phone that was asleep. The ring already knows, and knowing
     * early is what lets the answering side open the microphone — or the camera
     * — during those seconds rather than after them.
     */
    static final String EXTRA_KIND = "app.nearside.CALL_KIND";

    static final String ACTION_ACCEPT = "accept";
    static final String ACTION_DECLINE = "decline";
    static final String ACTION_OPEN = "open";
    /**
     * The system launched the activity, not the user.
     *
     * A full-screen intent fires *by itself* on a locked or sleeping phone —
     * that is what it is for — and the activity it starts is indistinguishable
     * from a tapped notification unless the two carry different actions. They
     * used to carry the same one, so the launch read as "the user has dealt
     * with this ring": the ring was cancelled and the call marked settled about
     * half a second after it was posted, on exactly the phones the push exists
     * for. Screen-on phones never hit it, because a device in use gets a
     * heads-up banner and no launch at all.
     */
    static final String ACTION_FULLSCREEN = "fullscreen";

    /** How long a ring can survive without anyone taking it down. */
    private static final long RING_TIMEOUT_MS = 60_000L;

    /**
     * Calls this process has already answered, declined or watched end.
     *
     * A call reaches a running app twice: once over the realtime topic, which is
     * what actually rings it, and once as the push that was sent to wake a phone
     * that might have been asleep. The push loses that race routinely — it goes
     * through Google's servers — and arriving second it used to raise the ring
     * again, on top of the call already in progress. An undismissable second
     * ring for the call you are on is what this set exists to prevent.
     *
     * Bounded, and deliberately only in memory: a process that has just started
     * knows nothing, which is exactly the cold-start case where the push *is*
     * the ring and must be allowed through.
     */
    private static final ArrayDeque<String> settled = new ArrayDeque<>();
    private static final int SETTLED_LIMIT = 16;

    private CallNotifications() {}

    /** Remember a call as dealt with, so a late push cannot raise it again. */
    static synchronized void markSettled(String callId) {
        if (callId == null || callId.isEmpty() || settled.contains(callId)) return;
        settled.addLast(callId);
        while (settled.size() > SETTLED_LIMIT) settled.removeFirst();
    }

    private static synchronized boolean isSettled(String callId) {
        return settled.contains(callId);
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = manager(context);
        if (nm == null) return;

        NotificationChannel incoming = new NotificationChannel(
            CHANNEL_INCOMING,
            "Incoming calls",
            NotificationManager.IMPORTANCE_HIGH
        );
        incoming.setDescription("Rings when a contact calls you");
        // The phone's own ringtone, played on the ringtone stream. The default
        // notification sound is a half-second chime, which for a call that
        // rings for forty-five seconds is not a ring — it is one blip and then
        // a silent screen nobody notices.
        incoming.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        incoming.enableVibration(true);
        incoming.setVibrationPattern(new long[] { 0, 800, 800, 800, 800 });
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        // Never bundled away or silenced by an automatic priority decision: a
        // ringing phone is the one notification that cannot be deferred.
        incoming.setBypassDnd(false);
        nm.createNotificationChannel(incoming);

        NotificationChannel ongoing = new NotificationChannel(
            CHANNEL_ONGOING,
            "Ongoing calls",
            NotificationManager.IMPORTANCE_LOW
        );
        ongoing.setDescription("Shown while a call is connected");
        ongoing.setSound(null, null);
        ongoing.enableVibration(false);
        nm.createNotificationChannel(ongoing);
    }

    /** Immutable, because none of these intents is filled in by the system. */
    private static int pendingFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static PendingIntent activityFor(
        Context context,
        String callId,
        String peerId,
        String kind,
        String action,
        int requestCode
    ) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        // Reuses the singleTask activity rather than stacking a second copy;
        // the extras arrive through onNewIntent.
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_PEER_ID, peerId);
        intent.putExtra(EXTRA_KIND, kind);
        intent.putExtra(EXTRA_ACTION, action);
        return PendingIntent.getActivity(context, requestCode, intent, pendingFlags());
    }

    /**
     * The ring.
     *
     * Answer goes straight to the activity rather than through a receiver.
     * Android 12 banned notification trampolines: an activity started from a
     * BroadcastReceiver that a notification action fired is silently dropped,
     * so an Answer button routed that way would dismiss the ring and open
     * nothing. Decline has no activity to start and stays a broadcast.
     */
    static void showRing(
        Context context,
        String callId,
        String peerId,
        String peerName,
        String kind
    ) {
        ensureChannels(context);
        NotificationManager nm = manager(context);
        if (nm == null || callId == null) return;
        // Answered, declined or over already — the push simply lost the race to
        // the realtime offer.
        if (isSettled(callId)) return;
        // A call is running. Whatever this ring is for, the app has already
        // replied "busy" to it over the signalling topic, so the caller is
        // gone and there is nothing here to answer.
        if (CallService.isRunning()) return;

        boolean video = "video".equals(kind);
        String name = peerName == null || peerName.isEmpty() ? "Someone" : peerName;

        Intent declineIntent = new Intent(context, CallActionReceiver.class);
        declineIntent.setAction(ACTION_DECLINE);
        declineIntent.putExtra(EXTRA_CALL_ID, callId);
        declineIntent.putExtra(EXTRA_PEER_ID, peerId);
        PendingIntent decline = PendingIntent.getBroadcast(context, 1, declineIntent, pendingFlags());

        PendingIntent answer = activityFor(context, callId, peerId, kind, ACTION_ACCEPT, 2);
        PendingIntent open = activityFor(context, callId, peerId, kind, ACTION_OPEN, 3);
        // Its own request code as well as its own action: two PendingIntents
        // that differ only in their extras and share a request code are the
        // same PendingIntent, and the second would silently take the first's
        // extras.
        PendingIntent fullScreen =
            activityFor(context, callId, peerId, kind, ACTION_FULLSCREEN, 5);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_INCOMING)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(name)
            .setContentText(video ? "Incoming video call" : "Incoming voice call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // Not dismissible by a swipe, and not cleared by tapping an action:
            // the ring goes away when the call is answered, declined or times
            // out, and nothing else.
            .setOngoing(true)
            .setAutoCancel(false)
            // Nothing on a locked, killed phone is guaranteed to take this
            // down: the caller's hangup reaches the app, and the app may not be
            // running. Without a deadline an ongoing, unswipeable ring outlives
            // the call that raised it, and the only way out is a reboot.
            .setTimeoutAfter(RING_TIMEOUT_MS)
            // Ring once. The same call can post this twice — the push behind
            // the realtime offer, or a display name that arrived late — and
            // each re-post would otherwise restart the ringtone from the top.
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            // The screen takeover. Android 14 may downgrade this to a heads-up
            // banner when the app has not been granted USE_FULL_SCREEN_INTENT —
            // see CallNative.fullScreenIntentAllowed, which is what the app asks
            // before promising the user their phone will ring.
            .setFullScreenIntent(fullScreen, true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decline)
            .addAction(android.R.drawable.sym_action_call, "Answer", answer);

        nm.notify(RING_ID, builder.build());
    }

    static void dismissRing(Context context) {
        NotificationManager nm = manager(context);
        if (nm != null) nm.cancel(RING_ID);
    }

    /**
     * The ongoing-call notification the foreground service is required to post.
     *
     * Content-free beyond the name, like every other notification this app
     * sends: the server has no body to leak and this one has nothing to say
     * beyond "a call is running", which is exactly what a foreground service
     * notification is for.
     */
    static Notification ongoing(Context context, String peerName, String kind) {
        ensureChannels(context);
        String name = peerName == null || peerName.isEmpty() ? "Nearside" : peerName;
        Intent open = new Intent(context, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.addCategory(Intent.CATEGORY_LAUNCHER);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        return new NotificationCompat.Builder(context, CHANNEL_ONGOING)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(name)
            .setContentText("video".equals(kind) ? "Video call" : "Voice call")
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setContentIntent(
                PendingIntent.getActivity(context, 4, open, pendingFlags())
            )
            .build();
    }
}
