package app.nearside;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super: the bridge builds its plugin registry during
        // BridgeActivity.onCreate, and a plugin registered afterwards is not in
        // it. The failure is a "plugin not implemented" rejection at the first
        // call, not a build error.
        registerPlugin(ScreenGuard.class);
        registerPlugin(CallNative.class);
        registerPlugin(MuteStore.class);
        super.onCreate(savedInstanceState);
        handleCallIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask means a ring tapped while the app is already running
        // arrives here rather than starting a second activity. Without the
        // setIntent the activity keeps reporting the intent it was launched
        // with, and the second call of a session is answered as the first.
        setIntent(intent);
        handleCallIntent(intent);
    }

    /**
     * A ring notification opened the app, or its Answer button did.
     *
     * The extras are removed after reading. `getIntent()` keeps returning the
     * same object for the life of the activity, so leaving them in place makes
     * every later resume look like another answered call.
     */
    private void handleCallIntent(Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra(CallNotifications.EXTRA_CALL_ID);
        if (callId == null) return;
        String action = intent.getStringExtra(CallNotifications.EXTRA_ACTION);

        showOverLockScreen();
        // Only a decision takes the ring down. Opening the app — whether the
        // user tapped the notification body or the full-screen intent launched
        // it on a sleeping phone — leaves the call ringing, because the app
        // being on screen is not an answer: the WebView still has to start, the
        // offer still has to arrive over a socket that has only just opened, and
        // a phone that goes back in a pocket in the meantime has to still be
        // ringing when it comes out.
        if (CallNotifications.ACTION_ACCEPT.equals(action)
            || CallNotifications.ACTION_DECLINE.equals(action)) {
            CallNotifications.dismissRing(this);
        }
        CallNative.deliver(
            callId,
            intent.getStringExtra(CallNotifications.EXTRA_PEER_ID),
            intent.getStringExtra(CallNotifications.EXTRA_KIND),
            action
        );

        intent.removeExtra(CallNotifications.EXTRA_CALL_ID);
        intent.removeExtra(CallNotifications.EXTRA_PEER_ID);
        intent.removeExtra(CallNotifications.EXTRA_KIND);
        intent.removeExtra(CallNotifications.EXTRA_ACTION);
    }

    /**
     * Show the call over the lock screen and wake the display.
     *
     * Set here rather than declared in the manifest: as a manifest attribute it
     * holds for every launch, and an app that sits over the lock screen
     * whenever it is opened is an app that appears not to lock. `CallNative`
     * clears both when the call ends.
     */
    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            );
        }
    }
}
