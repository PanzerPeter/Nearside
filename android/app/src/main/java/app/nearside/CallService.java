package app.nearside;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps a call alive once the phone is pocketed.
 *
 * Without a foreground service Android freezes the WebView within seconds of
 * the screen going off, and the call dies mid-sentence — which on a messenger
 * reads as the network dropping rather than as a missing service declaration.
 * The service also holds the audio focus and the in-communication audio mode,
 * both of which belong to the call's whole lifetime rather than to whichever
 * screen happens to be up.
 */
public class CallService extends Service {

    static final String EXTRA_KIND = "kind";
    static final String EXTRA_PEER_NAME = "peerName";
    static final String EXTRA_SPEAKER = "speaker";

    /**
     * Whether a call is up, for the notification path to ask.
     *
     * The ring and this service are raised by different processes' worth of
     * code — a push can arrive with the app dead — and a ring posted over a
     * call in progress is a call the user cannot answer and cannot silence.
     */
    private static volatile boolean running = false;

    static boolean isRunning() {
        return running;
    }

    private AudioFocusRequest focusRequest;
    private PowerManager.WakeLock wakeLock;
    private boolean holding = false;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String kind = intent != null ? intent.getStringExtra(EXTRA_KIND) : "voice";
        String peerName = intent != null ? intent.getStringExtra(EXTRA_PEER_NAME) : null;
        boolean speaker = intent != null && intent.getBooleanExtra(EXTRA_SPEAKER, false);
        boolean video = "video".equals(kind);
        running = true;

        // The type is not optional from Android 14: a microphone-using service
        // started without declaring it throws MissingForegroundServiceTypeException
        // and takes the process with it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            startForeground(CallNotifications.ONGOING_ID, CallNotifications.ongoing(this, peerName, kind), type);
        } else {
            startForeground(CallNotifications.ONGOING_ID, CallNotifications.ongoing(this, peerName, kind));
        }

        takeAudio();
        // After the mode switch, never before it. `setCommunicationDevice` is
        // resolved against the current audio mode, so a route chosen by the
        // WebView while this service was still starting is discarded by
        // `MODE_IN_COMMUNICATION` — which put the first seconds of every voice
        // call on the speaker.
        CallNative.applyRoute(this, speaker);
        takeWakeLock();
        // Not sticky: a call the system had to kill is over. Restarting the
        // service would put a call notification on screen with no call behind it.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseAudio();
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private AudioManager audio() {
        return (AudioManager) getSystemService(AUDIO_SERVICE);
    }

    /**
     * Take the audio focus and put the device in call mode.
     *
     * `MODE_IN_COMMUNICATION` is what routes capture and playback through the
     * voice path — it is also what makes the platform's echo canceller apply.
     * Without it the far end hears its own voice coming back through this
     * phone's speaker.
     */
    private void takeAudio() {
        AudioManager am = audio();
        if (am == null) return;
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .build();
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(
                null,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            );
        }
        holding = true;
    }

    private void releaseAudio() {
        AudioManager am = audio();
        if (am == null || !holding) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(null);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice();
        } else {
            am.setSpeakerphoneOn(false);
        }
        // Back to normal, or every notification sound afterwards comes out of
        // the earpiece at call volume.
        am.setMode(AudioManager.MODE_NORMAL);
        focusRequest = null;
        holding = false;
    }

    /**
     * A partial wake lock, because a foreground service does not keep the CPU
     * awake on its own.
     *
     * The audio path usually holds one implicitly, but a video call whose peer
     * has muted their microphone has stretches with no audio to hold anything,
     * and the phone suspends mid-call.
     */
    private void takeWakeLock() {
        if (wakeLock != null) return;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nearside:call");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock == null) return;
        if (wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
