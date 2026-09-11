package app.nearside;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;

/**
 * How loudly each conversation arrives, where a notification can reach it.
 *
 * The sibling of {@link MuteStore}, and it exists for exactly the same reason:
 * a push is delivered when the WebView is not running, so a preference held in
 * JavaScript is unreadable at the only moment it matters. SharedPreferences is
 * readable from the notification extension with no process of ours alive.
 *
 * Two stores rather than one because they answer different questions. Mute
 * decides whether anything is shown at all; this decides how it sounds when it
 * is. Folded together, unmuting would have to guess which loudness to go back
 * to.
 *
 * Written per account, like the mute list: a second account on this phone must
 * not inherit the first one's choices.
 *
 * There is no server-side copy, on purpose. Which conversations you want loud
 * and which you want quiet is a ranking of the people in your life, and the
 * server is never told it. The cost is that the choice does not follow you to a
 * second device — the same trade every other flag in `lib/chat-flags.ts` makes.
 */
@CapacitorPlugin(name = "AlertStore")
public class AlertStore extends Plugin {

    private static final String PREFS = "nearside_alerts";
    private static final String KEY_OWNER = "owner";
    /** One entry per conversation with a loudness of its own, as `id=level`. */
    private static final String KEY_PREFIX = "level:";

    /**
     * The channels a conversation can be routed to.
     *
     * Android decides a channel's importance once, when it is created, and
     * refuses to raise it afterwards — the user owns it from then on. So these
     * are created with the importance they are meant to have and never
     * modified, and somebody who turns one down in the system settings keeps
     * that decision. That is the correct behaviour and not a limitation: a
     * messenger that could make itself loud again after being turned down is a
     * messenger nobody can turn down.
     */
    static final String CHANNEL_QUIET = "nearside_quiet";
    static final String CHANNEL_URGENT = "nearside_urgent";

    @PluginMethod
    public void setLevels(PluginCall call) {
        String userId = call.getString("userId", "");
        JSObject levels = call.getObject("levels");

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor edit = prefs.edit();
        // Cleared and rewritten rather than merged: the map is the whole truth
        // each time, and a conversation set back to the ordinary loudness is
        // absent from it. Merging would leave that one loud forever.
        edit.clear().putString(KEY_OWNER, userId);

        if (levels != null) {
            Iterator<String> keys = levels.keys();
            while (keys.hasNext()) {
                String id = keys.next();
                String level = levels.optString(id, "");
                // Anything else is a level this build does not know, and is
                // dropped rather than stored: the extension would ignore it,
                // and a value nothing honours is worse left in the store.
                if ("quiet".equals(level) || "urgent".equals(level)) {
                    edit.putString(KEY_PREFIX + id, level);
                }
            }
        }
        edit.apply();
        ensureChannels(getContext());
        call.resolve();
    }

    /**
     * The channel a push from {@code id} should be shown on, or null for the
     * ordinary one OneSignal already chose.
     *
     * Called from the notification extension, which has a Context and nothing
     * else — no bridge, no activity, and no guarantee that any of our code has
     * run since boot.
     */
    static String channelFor(Context context, String id) {
        if (context == null || id == null || id.isEmpty()) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String level = prefs.getString(KEY_PREFIX + id, null);
        if ("quiet".equals(level)) return CHANNEL_QUIET;
        if ("urgent".equals(level)) return CHANNEL_URGENT;
        return null;
    }

    /**
     * Create both channels if they are not already there.
     *
     * Idempotent, and deliberately called from the extension as well as from
     * the plugin: a notification posted to a channel that does not exist is
     * dropped by Android without a word, and the extension may well be the
     * first of our code to run after a reinstall.
     */
    static void ensureChannels(Context context) {
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        if (manager.getNotificationChannel(CHANNEL_QUIET) == null) {
            NotificationChannel quiet = new NotificationChannel(
                CHANNEL_QUIET,
                context.getString(R.string.channel_quiet),
                NotificationManager.IMPORTANCE_LOW
            );
            quiet.setDescription(context.getString(R.string.channel_quiet_description));
            // IMPORTANCE_LOW already means no sound; both are set explicitly so
            // the channel says what it is rather than relying on a default.
            quiet.setSound(null, null);
            quiet.enableVibration(false);
            manager.createNotificationChannel(quiet);
        }

        if (manager.getNotificationChannel(CHANNEL_URGENT) == null) {
            NotificationChannel urgent = new NotificationChannel(
                CHANNEL_URGENT,
                context.getString(R.string.channel_urgent),
                NotificationManager.IMPORTANCE_HIGH
            );
            urgent.setDescription(context.getString(R.string.channel_urgent_description));
            urgent.enableVibration(true);
            urgent.setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build()
            );
            manager.createNotificationChannel(urgent);
        }
    }

    /** Forget everything, for a sign-out that must not leave the next account
     *  with the previous one's loud and quiet conversations. */
    @PluginMethod
    public void clear(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }
}
