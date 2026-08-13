# Building the native apps

Both shells wrap the same web app. `npm run android:sync` / `npm run ios:sync`
run a Vite build with `NEARSIDE_NATIVE=1` and copy it into the native project.
That flag disables the PWA service worker: a Workbox precache inside a WebView
keeps serving the previous build after an app update.

## Android

`applicationId` `app.nearside`, compile and target SDK 36, JDK 21.

```bash
npm run android:sync
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
```

Set `JAVA_HOME` explicitly wherever the system default JDK is newer than 21.
Gradle 8.14 fails at configuration time on a newer JDK, without a useful
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

## iOS

Same shell, bundle id `app.nearside`, deployment target 15.0, dependencies
through CocoaPods rather than SPM. `@capacitor-mlkit/barcode-scanning` ships no
`Package.swift`, and an SPM project drops it silently, taking QR scanning with
it.

**Everything past `npm run ios:sync` needs a Mac.** Xcode, CocoaPods, the
simulator, code signing and the upload to App Store Connect are macOS only, and
there is no supported way around it. A Linux checkout can edit the project and
copy the web build into it; it cannot compile it. Options in order of cost: a
Mac, a hosted Mac runner (GitHub Actions `macos-latest`, Codemagic, Bitrise), or
a rented cloud Mac.

```bash
npm run ios:sync                     # works anywhere
cd ios/App && pod install            # macOS
open App.xcworkspace                 # macOS, the workspace, never the project
```

Then in Xcode, once, by hand:

1. **Signing & Capabilities**, choose your team. Add **Push Notifications** and
   **Background Modes → Remote notifications**. The `Info.plist` key is already
   there; the entitlement is not, and only Xcode can add it.
2. Drag `GoogleService-Info.plist` into the `App` target. It is gitignored for
   the same reason `google-services.json` is. `AppDelegate` starts Firebase only
   when the file is present, so the app still launches without it, with no crash
   reporting.
3. Crashlytics needs the dSYM upload script. **Build Phases → + → New Run Script
   Phase**, `"${PODS_ROOT}/FirebaseCrashlytics/run"`, with input files
   `${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}`
   and `$(SRCROOT)/$(BUILT_PRODUCTS_DIR)/$(INFOPLIST_PATH)`.
4. Upload an APNs auth key (.p8) to OneSignal, and add
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
  Catalyst path. ML Kit barcode scanning is the likely casualty, which would
  cost QR scanning on that target.

Start with Designed for iPad. Catalyst earns its cost only if the Mac becomes a
target in its own right rather than a place the phone app also runs.
