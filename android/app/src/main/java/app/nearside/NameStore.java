package app.nearside;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * The names a notification is allowed to show, where the extension can read
 * them.
 *
 * Since 0061 the server holds no names: profiles and group titles are sealed,
 * and a push says "someone sent a photo" in "a group". The phone knows who
 * that someone is — it opened their profile to draw the chat list — so the
 * list hands its names down here, and `CallNotificationExtension` puts them
 * back into the banner before it is shown. Nothing here leaves the device.
 *
 * Two scopes, peers and rooms, written by the two lists that know them, so
 * neither overwrites the other's half.
 */
@CapacitorPlugin(name = "NameStore")
public class NameStore extends Plugin {

    private static final String PREFS = "nearside_names";

    @PluginMethod
    public void setNames(PluginCall call) {
        String scope = call.getString("scope", "");
        if (!"peers".equals(scope) && !"rooms".equals(scope)) {
            call.reject("scope must be peers or rooms");
            return;
        }
        JSObject names = call.getObject("names", new JSObject());
        getContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(scope, names.toString())
            .apply();
        call.resolve();
    }

    /** Sign-out: plaintext names must not outlive the account they belong to. */
    @PluginMethod
    public void clear(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }

    /** The name for a user or room id, or null when this device has none. */
    static String nameFor(Context context, String id) {
        if (context == null || id == null || id.isEmpty()) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        for (String scope : new String[] {"peers", "rooms"}) {
            String json = prefs.getString(scope, null);
            if (json == null) continue;
            try {
                String name = new JSONObject(json).optString(id, "");
                if (!name.isEmpty()) return name;
            } catch (Exception ignored) {
                // A half-written blob reads as no names, never as a crash in a
                // process that is only there to show a banner.
            }
        }
        return null;
    }

    /**
     * The word `send-push` puts where a sender's name used to go, in each of
     * the app's languages — `someone` in supabase/functions/_shared/push-copy.ts.
     * src/lib/push-copy.test.ts fails if the two lists drift.
     */
    static final String[] SOMEONE = {
        "someone", "alguien", "Unbekannt", "неизвестный отправитель",
        "valaki", "quelqu’un", "ktoś", "某人",
    };

    /** `body` with its "someone" replaced by `@name`, or unchanged. */
    static String named(String body, String name) {
        if (body == null || name == null) return body;
        for (String word : SOMEONE) {
            int at = body.indexOf(word);
            if (at >= 0) return body.substring(0, at) + "@" + name + body.substring(at + word.length());
        }
        return body;
    }
}
