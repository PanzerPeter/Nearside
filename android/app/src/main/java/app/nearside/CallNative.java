package app.nearside;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * The parts of a call the WebView cannot do for itself: the foreground service
 * that keeps it alive with the screen off, audio routing, and the lock-screen
 * ring.
 *
 * Media never comes near this class. `RTCPeerConnection` in the WebView holds
 * the DTLS keys and the SRTP packets; nothing here can see either, which is why
 * adding a native layer for reliability costs the app nothing in what it
 * claims. See src/lib/call/native.ts for the JavaScript side.
 */
@CapacitorPlugin(name = "CallNative")
public class CallNative extends Plugin {

    /**
     * The live plugin, for the notification path to reach.
     *
     * A ring is answered from a notification, which runs in a receiver or an
     * activity rather than in a plugin call, and has to get the decision across
     * to the WebView. Static because the notification exists before — and
     * sometimes without — this object.
     */
    private static CallNative instance;

    /**
     * A decision made before the WebView could hear it.
     *
     * The cold-start case: a push woke a killed app, the user tapped Answer on
     * the lock screen, and MainActivity is only now building the bridge. The
     * action is parked here and JavaScript collects it with
     * `consumePendingCall` once it is running.
     */
    private static JSObject pending;

    @Override
    public void load() {
        instance = this;
        CallNotifications.ensureChannels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Called from MainActivity and CallActionReceiver. */
    static void deliver(String callId, String peerId, String kind, String action) {
        if (callId == null || action == null) return;
        // The user has dealt with this ring. Said here rather than in each
        // caller, so the push that is still on its way through Google's servers
        // cannot raise the same call a second time whichever button was pressed.
        CallNotifications.markSettled(callId);
        JSObject data = new JSObject();
        data.put("callId", callId);
        data.put("peerId", peerId == null ? "" : peerId);
        // Voice or video, so the answering side can open the right capture
        // before the offer arrives to confirm it. Omitted rather than guessed
        // when the ring did not carry it.
        if (kind != null && !kind.isEmpty()) data.put("kind", kind);
        data.put("action", action);

        CallNative plugin = instance;
        if (plugin != null) {
            // Retained until something listens: the bridge can be up while the
            // React tree that registers the handler is still mounting, and an
            // answered call dropped in that window is the worst possible bug to
            // reproduce.
            plugin.notifyListeners("callAction", data, true);
        } else {
            pending = data;
        }
    }

    // ---- the call's lifetime ------------------------------------------------

    @PluginMethod
    public void startCall(PluginCall call) {
        Intent intent = new Intent(getContext(), CallService.class);
        intent.putExtra(CallService.EXTRA_KIND, call.getString("kind", "voice"));
        intent.putExtra(CallService.EXTRA_PEER_NAME, call.getString("peerName", ""));
        // The service applies this once it has taken the audio mode. Choosing a
        // communication device before that switch does not survive it.
        intent.putExtra(CallService.EXTRA_SPEAKER, Boolean.TRUE.equals(call.getBoolean("speaker", false)));
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CallService.class));
        CallNotifications.dismissRing(getContext());
        // Give the lock screen back. Left set, the app sits over the lock
        // screen for the rest of the session and the phone appears not to lock.
        Activity activity = getActivity();
        if (activity != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.runOnUiThread(() -> {
                activity.setShowWhenLocked(false);
                activity.setTurnScreenOn(false);
            });
        }
        call.resolve();
    }

    // ---- audio routing ------------------------------------------------------

    /**
     * Earpiece or speaker.
     *
     * `setSpeakerphoneOn` was deprecated in Android 12 in favour of
     * `setCommunicationDevice`, and on 13 and 14 the old call is increasingly a
     * no-op — a voice call that will not leave the earpiece on a modern phone
     * is this API and nothing else. Both paths are kept because minSdk is 24.
     *
     * Wired and Bluetooth headsets are deliberately not handled: routing to a
     * Bluetooth device needs BLUETOOTH_CONNECT, and asking a messenger's users
     * for a Bluetooth permission to place a call is a worse trade than letting
     * the platform's own default pick the headset, which it already does.
     */
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        applyRoute(getContext(), Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    /** Shared with CallService, which applies the call's opening route itself
     *  the moment it has taken the audio mode. */
    static void applyRoute(Context context, boolean on) {
        AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo target = findDevice(
                am,
                on ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            );
            if (target != null) am.setCommunicationDevice(target);
            else am.clearCommunicationDevice();
        } else {
            am.setSpeakerphoneOn(on);
        }
    }

    private static AudioDeviceInfo findDevice(AudioManager am, int type) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
        for (AudioDeviceInfo device : devices) {
            if (device.getType() == type) return device;
        }
        return null;
    }

    // ---- the ring -----------------------------------------------------------

    @PluginMethod
    public void showIncoming(PluginCall call) {
        CallNotifications.showRing(
            getContext(),
            call.getString("callId"),
            call.getString("peerId"),
            call.getString("peerName"),
            call.getString("kind", "voice")
        );
        call.resolve();
    }

    @PluginMethod
    public void dismissIncoming(PluginCall call) {
        // Named when the web layer knows which call it settled, so a push still
        // in flight for that same call cannot ring a phone that has already
        // answered it, declined it, or watched it end.
        CallNotifications.markSettled(call.getString("callId"));
        CallNotifications.dismissRing(getContext());
        call.resolve();
    }

    /**
     * Whether a ring would actually take over the screen.
     *
     * Android 14 stopped granting USE_FULL_SCREEN_INTENT at install to anything
     * Play does not classify as a calling or alarm app. Without it the ring is
     * downgraded to a heads-up banner — the phone buzzes rather than rings, and
     * a locked phone shows nothing. The app asks before telling anyone their
     * phone will ring.
     */
    @PluginMethod
    public void fullScreenIntentAllowed(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            result.put("allowed", true);
        } else {
            NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            result.put("allowed", nm != null && nm.canUseFullScreenIntent());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            call.resolve();
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
        intent.setData(Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void consumePendingCall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("pending", pending);
        // Once. A pending call left in place would re-answer on every resume.
        pending = null;
        call.resolve(result);
    }
}
