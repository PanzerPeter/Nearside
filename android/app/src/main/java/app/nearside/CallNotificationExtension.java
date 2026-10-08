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
 * carries no more than the message push already does — a caller's id. Their
 * name comes from this phone's own NameStore, since the server holds none. There is nothing about a call for it to leak; the server never sees a
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
        if (data == null) return;

        // A push for a conversation this device muted is discarded here, before
        // OneSignal displays it — including a call, because muting somebody and
        // then being rung by them at three in the morning is not what the
        // toggle promised. There is no server-side mute list on purpose, so the
        // phone pays for the delivery and then throws it away.
        // The conversation, which is what mute and loudness are keyed on: the
        // room for a room message (it carries its sender too, and asking for
        // that first meant a muted group never matched), the sender for a
        // direct one, and the caller for a ring, which `call-ring` names
        // `peerId` — read by nobody, so every muted contact still rang.
        String from = data.has("roomId")
            ? data.optString("roomId", "")
            : data.optString("senderId", data.optString("peerId", ""));
        if (MuteStore.isMuted(event.getContext(), from)) {
            event.preventDefault(true);
            return;
        }

        // Every other push this app sends is a message. Those are displayed as
        // OneSignal built them, with one change: a conversation given a
        // loudness of its own is moved onto the channel that carries it. The
        // channel decides the sound and whether the notification comes to the
        // front, and Android will not let either be set on the notification
        // itself once a channel exists.
        if (!"call".equals(data.optString("type"))) {
            String channel = AlertStore.channelFor(event.getContext(), from);
            if (channel != null) AlertStore.ensureChannels(event.getContext());

            // The server no longer knows anybody's name (0061), so the banner
            // arrives as "someone sent a photo" and, for a group, under "a
            // group". The names this phone already opened go back in here.
            String sender = NameStore.nameFor(event.getContext(), data.optString("senderId", ""));
            String room = data.has("roomId")
                ? NameStore.nameFor(event.getContext(), data.optString("roomId", ""))
                : null;
            String body = NameStore.named(event.getNotification().getBody(), sender);
            event.getNotification().setExtender(builder -> {
                if (channel != null) builder.setChannelId(channel);
                if (room != null) builder.setContentTitle(room);
                if (body != null) builder.setContentText(body);
                return builder;
            });
            return;
        }

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
            // `call-ring` stopped sending a name with 0061; an older server
            // still might, and either is better than "someone".
            data.optString(
                "peerName",
                ringName(NameStore.nameFor(event.getContext(), data.optString("peerId", "")))
            ),
            data.optString("kind", "voice")
        );
    }

    /** What the ring screen draws: `@name` as the server used to send it, or
     *  "Someone" for an id this phone has no name for. */
    private static String ringName(String name) {
        return name == null ? "Someone" : "@" + name;
    }
}
