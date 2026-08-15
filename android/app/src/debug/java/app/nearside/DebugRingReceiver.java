package app.nearside;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Debug builds only — see src/debug/AndroidManifest.xml for why it lives here
 * rather than behind a comment in the shipping manifest.
 *
 * Raises the ring notification on demand, so the lock-screen path can be
 * reproduced from adb without a second phone, a caller, or a push:
 *
 *   adb shell am broadcast -a app.nearside.DEBUG_RING --es callId test-1
 *
 * It exists because the failing case — a killed app on a locked phone — is the
 * one case no test can reach and the one case the push exists for.
 */
public class DebugRingReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra("callId");
        CallNotifications.showRing(
            context,
            callId == null ? "debug-call" : callId,
            intent.getStringExtra("peerId") == null ? "debug-peer" : intent.getStringExtra("peerId"),
            "Debug caller",
            "voice"
        );
    }
}
