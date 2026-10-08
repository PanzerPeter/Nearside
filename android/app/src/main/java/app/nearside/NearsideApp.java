package app.nearside;

import android.app.Application;
import android.os.Build;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Exists for one line of work: catching a native crash.
 *
 * Crashlytics used to do this and send the trace to Google on its own. Now the
 * trace is written to the app's private files and nothing more — on the next
 * launch `lib/crash-report.ts` reads it and asks whether to email it, with the
 * text in front of the user first. A crash report is the user's to send.
 *
 * An Application rather than MainActivity, because the call path runs without
 * the activity: a ring on a locked phone starts the process for CallService,
 * and a crash there is the one most worth knowing about.
 *
 * Release builds are minified, so the trace is obfuscated; it keeps line
 * numbers, and `retrace` with that release's mapping.txt turns it back.
 */
public class NearsideApp extends Application {
    /** Read by `lib/crash-report.ts` through the Filesystem plugin's Data directory. */
    static final String CRASH_FILE = "crash-report.txt";

    @Override
    public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler system = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try (FileWriter out = new FileWriter(new File(getFilesDir(), CRASH_FILE))) {
                StringWriter trace = new StringWriter();
                error.printStackTrace(new PrintWriter(trace));
                // PackageInfo rather than BuildConfig, which AGP 8 no longer generates.
                String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                out.write("Native crash on thread " + thread.getName() + "\n"
                        + "App " + version
                        + ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")\n"
                        + new java.util.Date() + "\n\n" + trace);
            } catch (Throwable ignored) {
                // Nothing to be done from inside a crash; the system dialog still follows.
            }
            // Hand back to Android, which shows its dialog and ends the process.
            if (system != null) system.uncaughtException(thread, error);
        });
    }
}
