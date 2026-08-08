# Nearside

An end-to-end encrypted messenger for Android and iOS. One-to-one chats and
group rooms, text, photos, video and voice notes, with the keys held on the
device and nothing readable on the server.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey)
![Tests](https://img.shields.io/badge/tests-390%20passing-brightgreen)

Built with React, TypeScript and Vite, wrapped in Capacitor, backed by Supabase
for auth, Postgres, realtime and storage. The browser build is a development
convenience. The shipping targets are the two native builds.

## Contents

- [What makes it different](#what-makes-it-different)
- [Encryption](#encryption)
- [Features](#features)
- [How it makes money](#how-it-makes-money)
- [Where the protection stops](#where-the-protection-stops)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [Android](#android)
- [iOS](#ios)
- [macOS](#macos)
- [Appearance and theme packs](#appearance-and-theme-packs)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

## What makes it different

**The server has no message bodies.** Migration `0023` dropped the `content`
column and the server-side search that read it. What Postgres holds is a
ciphertext and a nonce. Search and conversation previews run against a local
SQLite mirror of what this device has decrypted, one database file per account.

**There is no directory.** `search_profiles()` is gone. Display names collide
freely and nobody can be found by one. You connect by scanning a QR code or by
reading an eight-character code aloud, and a scan also verifies the contact,
because the key travelled in the QR. Codes are single-use and expire in ten
minutes.

**Notifications carry a sender and never a message.** Not as a policy, as a
consequence: after `0023` the server has no body to leak. The push function
could not include one if it tried.

**The transparency screen is built from live queries.** "What the server knows"
reads the real schema through `public_table_names()` rather than reciting
hard-coded copy that can go stale. Two tests enforce the claims the product
makes: `no-plaintext.test.ts` fails if a body ever reaches an insert payload,
and `no-ads.test.ts` fails if an advertising SDK appears in `package.json` or
the Gradle build.

## Encryption

Twelve words produce a seed. The seed is stored in Android's Keystore or the
iOS Keychain, per account, and never leaves the device. Three keys derive from
it through fixed context labels: a box key for peer messages, an Ed25519
signing key, and a vault key for your own notes.

- **Self-chat** seals under `crypto_secretbox` with the vault key.
- **One-to-one** seals under `crypto_box` to the peer's published public key.
- **Rooms** hold one symmetric key, sealed once per member, and every message
  carries an Ed25519 signature that is checked *before* the message is opened.
  Every member holds the room key, so only the signature establishes authorship.
- **Attachments** get a random per-file key. They upload as
  `application/octet-stream` with the nonce prepended, and the file key travels
  sealed in the message row.

`src/lib/sealed-body.ts` is the only place a body is sealed or opened. There is
no plaintext fallback anywhere: `sealBody` throws when a peer has published no
key rather than degrading, because a fallback would be invisible to the sender
and would quietly falsify the product's central claim.

Losing the twelve words loses the history. There is no reset path, no support
process, and nobody who can help.

## Features

**Messaging.** Real-time one-to-one chat with typing indicators, read receipts,
replies, reactions, edit and soft delete, forwarding, and a note-to-self vault
pinned to the top of the list.

**Group rooms.** One symmetric key per room, sealed to each member's published
key. Adding a member is one row, not a re-encryption of the history. A message
whose signature fails renders as a warning rather than being hidden, because a
dropped message is an attack the user never learns about.

**Media.** Images re-encoded to WebP on the device before upload, video, and
voice notes up to two minutes with a live level meter while recording. Camera
capture straight into the conversation. Server-side pruning keeps the newest 20
photos and videos and the newest 50 voice notes per conversation, and pinning an
attachment writes the decrypted copy into app-private storage so it survives
that pruning. Pinning is free and always will be.

**Trust.** Safety numbers with a verified badge in the chat header, and a
blocked composer when a contact's key changes under you. The app does not guess
whether that was a reinstall or an interception.

**Private nicknames.** Name someone whatever you like. They are never told, and
the name follows them into the sidebar, the chat header and your notifications.

**Survives bad networks.** The app detects wake from three signals, including a
wall-clock jump that is the only thing that fires on a woken desktop. One
`generation` counter rebuilds every realtime subscription and re-runs the
fetches beside them. When the WebSocket is blocked, which some corporate proxies
and VPN routes do while ordinary HTTPS keeps working, the app polls and a banner
says so rather than showing a frozen conversation.

**Unsent messages are durable.** The outbox persists to IndexedDB with
client-generated uuids, so a retry after a lost response collides on the primary
key instead of writing a second copy.

## How it makes money

Cosmetics, sold once, through RevenueCat. Six decorative theme packs. That is
the entire revenue line.

Nothing functional is behind a purchase, and there is no advertising SDK in the
build. Light mode and the OLED black are free, because charging for a screen
someone can read outdoors would be a functional paywall wearing a cosmetic
label. From the header of `src/lib/purchases.ts`:

> A privacy product that paywalls privacy has sold the thing it claims to
> defend.

`no-ads.test.ts` fails the suite if an advertising SDK ever appears. The
constraint is enforced, not promised.

## Where the protection stops

Nearside is honest about its limits, and ships a screen inside the app that says
so. In short:

- The server knows who talks to whom and when. Metadata is not encrypted.
- `profiles.display_name` and `last_seen_at` are readable by the server.
- A compromised device is a compromised account. The seed lives in hardware
  storage, but a rooted or jailbroken phone can reach it.
- Removing someone from a room does not claw back what they already hold.
- This is not a Signal replacement. If you are at serious risk, use Signal. The
  app says this in the same words, on its security-limits page.

## Getting started

### Prerequisites

- Node.js 20.19 or newer, which Vite 8 requires
- A Supabase project
- Android builds: Android SDK 36 and JDK 21
- iOS builds: macOS with Xcode 15 or newer, and CocoaPods

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Supabase project, then run the migrations by hand in the SQL editor.
   **Apply order is not numeric order**, and later files supersede parts of
   earlier ones, so read each file's header banner before running it:

   - `0001_init.sql` through `0013_chat_backgrounds_per_user.sql` in ascending
     order: tables, RLS, triggers, realtime
   - `0014_server_side_push.sql`, optional, and inert until configured. See
     `supabase/SETUP.md`
   - `0015` through `0021`: voice messages, friend nicknames, the self-chat,
     forwarding, open signup, identity keys, encrypted bodies
   - `0022_display_name.sql`, then `0023` through `0025`: the profile rename,
     the server losing message bodies, encrypted media, sealed media MIME
   - `0022b_no_directory.sql`, applied **after** `0025`. It drops
     `search_profiles()` and adds `connect_tokens` with its mint and redeem
     RPCs. The number records authorship order; this list records apply order
   - `0026_rooms.sql`: rooms, participants, sealed per-member keys, signed room
     messages
   - `0027_transparency.sql`: `public_table_names()`, so the transparency screen
     compares itself against the real schema
   - `0028_drop_web_push.sql`: drops `push_subscriptions` and the VAPID
     transport
   - `supabase/storage-setup.sql`: the `avatars` and `chat-media` buckets and
     their policies

3. In Supabase under **Authentication → URL Configuration**, add your site URL
   and a `/*` redirect so password-reset links return to the app.

   For native builds, add both deep-link targets to **Additional Redirect
   URLs**. GoTrue rejects any `redirect_to` that is not on this list, and the
   emailed link then falls back to the Site URL, which no phone can open:

   ```
   app.nearside://auth/confirm
   app.nearside://auth/recovery
   ```

4. Copy `.env.example` to `.env` and fill in your project values:

   ```bash
   cp .env.example .env
   ```

   ```
   VITE_SUPABASE_URL=https://<your-project>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-anon-or-publishable-key>
   ```

5. Deploy the notification function and give it its secrets:

   ```bash
   supabase functions deploy send-push --no-verify-jwt
   supabase secrets set ONESIGNAL_APP_ID=... ONESIGNAL_REST_API_KEY=...
   ```

   The REST key is server-side only. Vite inlines every `VITE_`-prefixed
   variable into the bundle, so putting it in `.env` would publish it inside
   every APK.

6. Run locally:

   ```bash
   npm run dev
   ```

## Scripts

| Command                | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Start the dev server                              |
| `npm run build`        | Production build to `dist/`                       |
| `npm run preview`      | Preview the production build                      |
| `npm run test`         | Run the vitest suite                              |
| `npm run typecheck`    | TypeScript check on both tsconfigs, no emit       |
| `npm run lint`         | ESLint                                            |
| `npm run android:sync` | Native build and copy into `android/`             |
| `npm run android:open` | Open `android/` in Android Studio                 |
| `npm run ios:sync`     | Native build and copy into `ios/`                 |
| `npm run ios:open`     | Open `ios/` in Xcode, macOS only                  |

## Android

The Play build is a Capacitor shell around the same web app, `applicationId`
`app.nearside`. It needs the Android SDK at compile and target 36, and JDK 21.
Gradle 8.14 does not run on newer JDKs.

```bash
npm run android:sync
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
```

Set `JAVA_HOME` explicitly wherever the system default JDK is newer than 21.
Gradle fails at configuration time rather than with a version message. It finds
the SDK through `android/local.properties`, which is gitignored and holds a
single line:

```properties
sdk.dir=/absolute/path/to/Android/Sdk
```

`android:sync` sets `NEARSIDE_NATIVE=1`, which disables the PWA service worker
for native builds. A Workbox precache inside a WebView keeps serving the
previous build after an app update.

Release builds run R8 with `minifyEnabled true`. Every Capacitor and Cordova
plugin is reached reflectively from the WebView bridge, so R8 sees no caller for
any of them. `android/app/proguard-rules.pro` is the only thing keeping them,
and a missing rule shows up as a runtime crash rather than a build failure. Test
a release build on hardware, not just a debug one.

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

The `ios/` project is the same Capacitor shell around the same web app, bundle
id `app.nearside`, deployment target 15.0, dependencies through CocoaPods rather
than SPM. `@capacitor-mlkit/barcode-scanning` ships no `Package.swift`, and an
SPM project drops it silently, taking QR scanning with it.

**Everything past `npm run ios:sync` needs a Mac.** Xcode, CocoaPods, the
simulator, code signing and the upload to App Store Connect are all macOS only,
and there is no supported way around it. A Linux checkout can edit the project
and copy the web build into it. It cannot compile it. Options in order of cost:
a Mac, a hosted Mac runner such as GitHub Actions `macos-latest`, Codemagic or
Bitrise, or a rented cloud Mac.

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

Two things will fail review if left alone:

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

## Appearance and theme packs

Nine themes ship. Three are free and need no store configuration: `nearside`
(the default), Daylight and Void. The other six are non-consumable purchases
through RevenueCat.

Every theme lives in two places and the two must agree: a daisyUI block in
`tailwind.config.js`, and an entry in `PACKS` or `FREE_THEMES` in
`src/lib/purchases.ts`. A pack's `id` is simultaneously its RevenueCat
entitlement id, its store product id, and what `packOffers()` matches an
offering on. `purchases.test.ts` fails if a listed theme has no block behind it,
or if a block is missing one of the `--surface-ring`, `--receipt-read` or
`--presence-offline` tokens the components read.

To sell a pack, per store:

1. Create a **non-consumable** product with the pack id verbatim
   (`pack.midnight`, `pack.paper`, `pack.terminal`, `pack.sunset`,
   `pack.sakura`, `pack.graphite`) in the Play Console or App Store Connect.
2. In RevenueCat, attach each product to an **entitlement of the same id** and
   put all six packages in the **current offering**. `packOffers()` reads only
   the current offering, and a pack missing from it renders as "Unavailable"
   rather than at a made-up price.
3. Set `VITE_REVENUECAT_ANDROID_KEY` and `VITE_REVENUECAT_IOS_KEY` in `.env`.
   They are different publishable keys for different store apps and are not
   interchangeable. `initPurchases` picks by platform.

None of this is load-bearing. With no keys, no offering, or no network, the
store lists every pack as unavailable, the free themes still work, and the rest
of the app is untouched.

The preview button beside each theme renders a sample conversation in that theme
without applying it, by setting `data-theme` on that element rather than on
`<html>`. Nothing is stored and there is no state to walk back. It works in the
browser build too, which is the only way to judge a pack on a machine that
cannot buy one.

## Testing

```bash
npm run test                                  # the whole suite
npx vitest run src/lib/outbox.test.ts         # one file
npx vitest run -t 'never puts a message body' # one test by name
```

Tests are vitest in a node environment over `src/**/*.test.ts`. There is no DOM
or component test setup, which is deliberate: logic that needs testing gets
pushed out of components and into `src/lib/`, where it can be tested without a
renderer.

Two of them are load-bearing rather than incidental. `lib/no-plaintext.test.ts`
fails if a message body ever reaches an insert payload. `lib/no-ads.test.ts`
fails if an advertising SDK appears in `package.json` or the Gradle build. Both
exist so the claims on the store listing stay true by construction.

## Project layout

```
src/
  components/   UI. ChatRoom is a shell; the work lives in hooks/
  hooks/        useChatThread is the conversation hub, composing outbox,
                receipts and scroll
  lib/          Everything testable. crypto/, sealed-body.ts (the seal
                boundary), message-queries.ts (returns rows still sealed),
                localdb.ts (the local SQLite mirror), connection.ts (wake and
                generation), purchases.ts, rooms.ts
supabase/
  migrations/   Applied by hand. Read each header banner first
  functions/    send-push and delete-account, Deno
android/        Capacitor shell, the mature target
ios/            Capacitor shell, configured but never compiled
```

## Contributing

Issues and pull requests are welcome. A few things worth knowing before you
open one:

- Comments explain *why*, and usually name the failure the code prevents. A
  comment restating the line below it does not belong.
- Run `npm run typecheck`, `npm run lint` and `npm run test` before pushing.
  All three are expected to pass.
- Changing `BOX_CONTEXT`, `SIGN_CONTEXT` or `VAULT_CONTEXT` in
  `src/lib/crypto/keys.ts` invalidates every existing user's keys. Do not.
- Any new per-account cache has to be torn down in `App.signOut` as well. A
  surviving peer-key cache breaks trust-on-first-use for the next account on the
  phone.
- Privacy claims in the UI are built from live queries and real schema, not
  hard-coded copy. Keep them checkable.

Found a security problem? Please open a private security advisory on the
repository rather than a public issue.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

Copyleft is a deliberate choice for this project. Anyone shipping a modified
Nearside has to publish their changes, which matters more than usual for an
encrypted messenger: a closed fork is a fork whose crypto nobody can check.
