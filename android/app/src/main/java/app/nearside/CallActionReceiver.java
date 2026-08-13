package app.nearside;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Decline, from the ring notification.
 *
 * Only decline. Answer is a `getActivity` PendingIntent instead, because
 * Android 12 banned notification trampolines: an activity started from a
 * receiver that a notification action fired is dropped without a word, so an
 * Answer routed through here would dismiss the ring and open nothing.
 *
 * Declining has no screen to show, which is exactly why it can live here — and
 * why it works with the phone still locked and the app never brought forward.
 *
 * One limit, and it is a real one. Telling the *caller* they were declined
 * means sealing a signal to their key, and the key lives in the Keystore behind
 * a WebView that is not running when a push woke a killed app. So a decline
 * from a cold start silences this phone and the caller sees "no answer" when
 * the ring times out instead. With the app alive — the common case, since a
 * ring usually arrives over the realtime topic rather than the push — the
 * listener below fires immediately and the caller is told at once.
 */
public class CallActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !CallNotifications.ACTION_DECLINE.equals(intent.getAction())) return;
        CallNotifications.dismissRing(context);
        CallNative.deliver(
            intent.getStringExtra(CallNotifications.EXTRA_CALL_ID),
            intent.getStringExtra(CallNotifications.EXTRA_PEER_ID),
            null,
            CallNotifications.ACTION_DECLINE
        );
    }
}
