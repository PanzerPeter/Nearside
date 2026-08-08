package app.nearside;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super: the bridge builds its plugin registry during
        // BridgeActivity.onCreate, and a plugin registered afterwards is not in
        // it. The failure is a "plugin not implemented" rejection at the first
        // call, not a build error.
        registerPlugin(ScreenGuard.class);
        super.onCreate(savedInstanceState);
    }
}
