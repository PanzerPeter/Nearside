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

## Desktop (CachyOS / Arch)

The desktop target is Electron, via `@capawesome/capacitor-electron`. It is a
convenience build, not a third shipping target — read "What the desktop build
does not do" below before relying on it.

### First time

The `electron/` project has its own `package.json` and its own `node_modules`
(Electron itself is a ~100 MB download). It is deliberately **not** wired into
the repo's `postinstall`, so a plain `npm install` for the Android work does not
drag Electron down with it:

```bash
npm install                 # repo root, as usual
npm run electron:install    # once — installs into electron/
```

### Run it

```bash
npm run electron:start      # builds the web assets, syncs, launches
```

`electron:start` runs `electron:sync` first, which is `NEARSIDE_NATIVE=1 vite
build && cap sync`. The flag matters for the same reason it does on Android: it
disables the PWA service worker, and a Workbox precache inside a packaged shell
goes on serving the previous build after an update.

**Do not launch it from a VS Code integrated terminal.** VS Code exports
`ELECTRON_RUN_AS_NODE=1` to its child shells, and that variable tells *any*
Electron binary to behave as plain Node: no `app`, no window, no error — the
process starts, runs `main.js` as a script, and exits 0. It looks exactly like a
broken build. Use a normal terminal, or strip the variable:

```bash
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE npm run electron:start
```

### Build an installable package

```bash
npm run electron:pack
```

Output lands in `electron/dist/`:

- `Nearside-<version>.AppImage` — one file, runs anywhere, needs no root.
- `nearside-<version>.pacman` — a real Arch package.

### Install on CachyOS

Prefer the pacman package. `pacman` then owns the files, which means it can
also remove them; an AppImage sitting in `~/Downloads` is tracked by nothing,
and two copies of it are two applications:

```bash
sudo pacman -U electron/dist/nearside-*.pacman
```

If you would rather keep it self-contained, the AppImage needs only the execute
bit:

```bash
chmod +x electron/dist/Nearside-*.AppImage
./electron/dist/Nearside-*.AppImage
```

Some Arch kernels — CachyOS among them — restrict unprivileged user
namespaces, which Electron's sandbox needs. If the AppImage exits complaining
about `chrome-sandbox` or namespaces:

```bash
sysctl kernel.unprivileged_userns_clone     # 0 means restricted
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

The pacman package is not affected: `chrome-sandbox` is installed setuid there.

### Updating

There is **no auto-update**, deliberately. An auto-updater is a channel that
hands the app executable code and asks it to trust the source — which is the
one thing this app's design says it does not do about its own server. Updates
are manual:

```bash
git pull
npm install && npm run electron:install    # only if dependencies changed
npm run electron:pack
sudo pacman -U electron/dist/nearside-*.pacman   # same command as installing
```

`pacman -U` on a newer version upgrades in place — it does not need `-R` first,
and it will refuse a *downgrade* unless you pass `--overwrite`. For the AppImage,
replace the file.

Uninstall:

```bash
sudo pacman -R nearside
```

### What the desktop build does not do

Electron reports `Capacitor.getPlatform() === 'electron'` and
`isNativePlatform() === true`, but it has none of the native plugins the mobile
builds are written against — `cap sync` says so out loud: *"Found 0 plugin(s)
with an electron implementation."* So the app asks `isMobileNative()`
(`src/lib/platform.ts`) instead, and the desktop shell takes the browser path
everywhere. What that costs:

- **The seed is not hardware-backed.** There is no Keystore or Keychain here; it
  lives in localStorage, exactly as in a browser tab. The identity screen says
  so — that is `isSecureStorageAvailable()` reporting honestly, not a bug.
- **No local SQLite mirror**, so no offline search and no conversation previews
  from this device. `@capacitor-community/sqlite` ships an Electron
  implementation that is missing from the package; the sync warning names it.
- **No push notifications** (OneSignal) and **no purchases** (RevenueCat).
- **No app-lock screen guard** — `FLAG_SECURE` is an Android window flag.
- **No QR scanning** — the barcode plugin is Android-only already.

Messaging, calls, media and the sealed exchange all work: they are Supabase,
WebRTC and libsodium, none of which need a native plugin.
