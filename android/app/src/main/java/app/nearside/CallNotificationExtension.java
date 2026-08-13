package app.nearside;

import com.onesignal.notifications.INotificationReceivedEvent;
import com.onesignal.notifications.INotificationServiceExtension;

import org.json.JSONObject;

/**
 * Turns the push that says "someone is calling you" into a ring.
 *
 * OneSignal's own notification is a banner in the shade. For a message that is
 * the whole point; for a call it is useless — nobody watches the shade waiting
 * for a call, and a locked phone shows nothing at all. This intercepts the
 * push before it is displayed and posts a full-screen-intent notification
 * instead, which is what takes over the screen and rings.
 *
 * This runs when the app may not be running at all. That is the case it exists
 * for: a call to a phone in a pocket, with the WebView not merely backgrounded
 * but gone. Everything it needs is in the payload, and the payload deliberately
 * carries no more than the message push already does — a caller's id and their
 * display name, which the transparency screen already lists as readable by the
 * server. There is nothing about a call for it to leak; the server never sees a
 * call's contents, its duration, or that it happened.
 *
 * Registered from AndroidManifest.xml by class name, under the meta-data key
 * `com.onesignal.NotificationServiceExtension`. It is never constructed by any
 * code here, so R8 has to be told to keep it — see proguard-rules.pro.
 */
public class CallNotificationExtension implements INotificationServiceExtension {

    @Override
    public void onNotificationReceived(INotificationReceivedEvent event) {
        JSONObject data = event.getNotification().getAdditionalData();
        // Every other push this app sends is a message, and those must go on
        // being displayed exactly as OneSignal built them.
        if (data == null || !"call".equals(data.optString("type"))) return;

        String callId = data.optString("callId", null);
        if (callId == null || callId.isEmpty()) return;

        // Discard rather than defer: a ring is posted below in its place, and a
        // deferred notification that is never displayed lingers in OneSignal's
        // bookkeeping as one that might still be.
        event.preventDefault(true);

        CallNotifications.showRing(
            event.getContext(),
            callId,
            data.optString("peerId", ""),
            data.optString("peerName", ""),
            data.optString("kind", "voice")
        );
    }
}
