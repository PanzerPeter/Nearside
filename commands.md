# Commands

## Android emulator

Neither `emulator` nor `adb` is on `PATH`; both live under the SDK named in
`android/local.properties` (`sdk.dir=/home/peter/Android/Sdk`).

Start the AVD (`nearside36`), detached so the shell stays usable:

```bash
~/Android/Sdk/emulator/emulator -avd nearside36 &
```

Available AVDs:

```bash
~/Android/Sdk/emulator/emulator -list-avds
```

Wait for it to finish booting, then install the current build:

```bash
~/Android/Sdk/platform-tools/adb wait-for-device
~/Android/Sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Logs from the app only:

```bash
~/Android/Sdk/platform-tools/adb logcat --pid=$(~/Android/Sdk/platform-tools/adb shell pidof app.nearside)
```
