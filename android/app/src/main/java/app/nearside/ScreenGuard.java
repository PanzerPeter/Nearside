package app.nearside;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FLAG_SECURE on the activity window.
 *
 * Without it Android permits a screenshot, a screen recorder, and a thumbnail
 * in the recents switcher. For a screen holding twelve recovery words — the
 * only copy of a key with no reset path — all three are the same leak.
 *
 * The flag is a window property, so it must be set on the UI thread; setting it
 * from the bridge thread throws and the call fails silently into the WebView.
 */
@CapacitorPlugin(name = "ScreenGuard")
public class ScreenGuard extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        );
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        );
        call.resolve();
    }
}
