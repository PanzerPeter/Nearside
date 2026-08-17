package app.nearside;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The muted set, where a notification can reach it.
 *
 * A push arrives when the WebView is not running — that is the case the whole
 * notification path exists for — so a mute list held in JavaScript, in
 * IndexedDB, or in the SQLite mirror is a mute list that is unreadable at the
 * only moment it matters. SharedPreferences is readable from the notification
 * extension with no process of ours alive.
 *
 * Written per account: the ids are stored under the signed-in user id, because
 * a second account on the phone must not inherit the first one's silences. The
 * owner is recorded alongside them so a stale set — written by an account that
 * has since been switched away from — is never consulted for the wrong one.
 *
 * There is no server-side mute list on purpose. The server is never told which
 * conversations you keep quiet, and the cost of that choice is that the phone
 * pays for the delivery and then throws it away.
 */
@CapacitorPlugin(name = "MuteStore")
public class MuteStore extends Plugin {

    private static final String PREFS = "nearside_mute";
    private static final String KEY_OWNER = "owner";
    private static final String KEY_IDS = "muted_ids";

    @PluginMethod
    public void setMuted(PluginCall call) {
        String userId = call.getString("userId", "");
        JSArray ids = call.getArray("ids");
        Set<String> set = new HashSet<>();
        if (ids != null) {
            try {
                List<String> list = ids.toList();
                set.addAll(list);
            } catch (JSONException e) {
                call.reject("muted ids must be strings");
                return;
            }
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_OWNER, userId).putStringSet(KEY_IDS, set).apply();
        call.resolve();
    }

    /**
     * Whether a push from `id` belongs to a conversation this device muted.
     *
     * Called from the notification extension, which has a Context and nothing
     * else — no bridge, no activity, and no guarantee that any of our code has
     * run since boot.
     */
    static boolean isMuted(Context context, String id) {
        if (context == null || id == null || id.isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> ids = prefs.getStringSet(KEY_IDS, null);
        return ids != null && ids.contains(id);
    }

    /** Forget everything, for a sign-out that must not leave the next account
     *  silenced on conversations it has never seen. */
    @PluginMethod
    public void clear(PluginCall call) {
        getContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_OWNER)
            .remove(KEY_IDS)
            .apply();
        call.resolve();
    }
}
