# Building the native apps

Both shells wrap the same web app. `npm run android:sync` / `npm run ios:sync`
run a Vite build with `NEARSIDE_NATIVE=1` and copy it into the native project.
That flag disables the PWA service worker: a Workbox precache inside a WebView
keeps serving the previous build after an app update.

The Electron desktop shell is a convenience build, not a shipping target, and
is covered in [commands.md](../commands.md).

## Android

`applicationId` `app.nearside`, compile and target SDK 36, minimum SDK 24,
JDK 21.

```bash
npm run android:sync
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug    # emulator
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleRelease  # phone
```

Set `JAVA_HOME` explicitly wherever the system default JDK is newer than 21.
The Gradle 8.14 wrapper fails at configuration time on a newer JDK, without a useful
message. It finds the SDK through `android/local.properties`, gitignored, one
line:

```properties
sdk.dir=/absolute/path/to/Android/Sdk
```

Release builds run R8 with `minifyEnabled true`. Every Capacitor and Cordova
plugin is reached reflectively from the WebView bridge, so R8 sees no caller for
any of them; `android/app/proguard-rules.pro` is the only thing keeping them,
and a missing rule shows up as a runtime crash rather than a build failure.
**Test a release build on hardware, not just a debug one.**

Keep each release's `android/app/build/outputs/mapping/release/mapping.txt`.
A crash report from a release build (the user emails it; nothing is uploaded
automatically) names obfuscated classes, and only that file turns it back:
`~/Android/Sdk/cmdline-tools/latest/bin/retrace mapping.txt report.txt`. The
next build overwrites it.

Two files are needed locally and are deliberately not in version control:
`android/app/google-services.json`, and `android/keystore.properties`, which
points at the upload keystore:

```properties
storeFile=/absolute/path/to/nearside-upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

Release builds are unsigned without it. Debug builds do not need it.

### Which build goes where

The emulator carries the debug-signed app; the release APK is signed with the
upload key and belongs on a physical phone. Installing a release build over a
debug one fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. **Do not fix that
with `adb uninstall`.** The identity seed lives in the Android Keystore, it is
the only copy, and uninstalling deletes it. The account on that device is then
recoverable only from its twelve words. Build the matching variant instead:

```bash
~/Android/Sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## iOS

Same shell, bundle id `app.nearside`, deployment target 15.0, dependencies
through CocoaPods rather than SPM. That was forced by the old ML Kit scanner,
which had no `Package.swift`; every plugin left has one, but OneSignal arrives
as a Cordova plugin and the move is untested, so the project stays on
CocoaPods until somebody with a Mac makes it.

**Everything past `npm run ios:sync` needs a Mac.** Xcode, CocoaPods, the
simulator, code signing and the upload to App Store Connect are macOS only, and
there is no supported way around it. A Linux checkout can edit the project and
copy the web build into it; it cannot compile it. Options in order of cost: a
Mac, a hosted Mac runner (GitHub Actions `macos-latest`, Codemagic, Bitrise), or
a rented cloud Mac.

Without a Mac or a developer account, the `ios-sideload` workflow (Actions →
Run workflow) builds an unsigned `.ipa` on a hosted runner and publishes it to
the `ios-latest` prerelease. Testers sign it with their own free Apple ID;
[IOS-SIDELOAD.md](IOS-SIDELOAD.md) is the guide to send them. Those builds have
no push and expire every 7 days.

```bash
npm run ios:sync                     # works anywhere
cd ios/App && pod install            # macOS
open App.xcworkspace                 # macOS, the workspace, never the project
```

Then in Xcode, once, by hand:

1. **Signing & Capabilities**, choose your team. Add **Push Notifications** and
   **Background Modes → Remote notifications**. The `Info.plist` key is already
   there; the entitlement is not, and only Xcode can add it.
2. Upload an APNs auth key (.p8) to OneSignal, and add
   `app.nearside://auth/confirm` and `app.nearside://auth/recovery` to
   Supabase's redirect allow-list. The scheme is claimed in `Info.plist` and
   works the same way as Android's intent filter.

Two things will fail App Review if left alone:

- **Export compliance.** Nearside is end-to-end encrypted with libsodium, which
  is not exempt. Do not set `ITSAppUsesNonExemptEncryption` to `false`; it is
  deliberately absent from `Info.plist`. File the self-classification report
  through Apple's CCATS/ERN flow and answer the App Store Connect questions
  honestly.
- **Account deletion.** Apple requires an in-app path for any app with accounts.
  There is one, under Settings, backed by the `delete-account` edge function.
  Be ready to point the reviewer at it.

## macOS

Two routes, neither of them a second codebase:

- **Designed for iPad** runs the iOS build unmodified on Apple Silicon Macs.
  Tick the Mac checkbox under the target's **Supported Destinations** and it
  appears in the Mac App Store. Free, and the WebView-based UI takes it well.
  Intel Macs are excluded.
- **Mac Catalyst** produces a real Mac binary with resizable windows and a menu
  bar. It is also a separate build to test and sign, and some plugins have no
  Catalyst path. QR scanning is not among them: it runs in the WebView.

Start with Designed for iPad. Catalyst earns its cost only if the Mac becomes a
target in its own right rather than a place the phone app also runs.
