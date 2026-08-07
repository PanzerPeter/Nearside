# Nearside

A fast, real-time direct-messaging app for Android, built as a Capacitor shell
around a React web app. Chat one-to-one with text, images, voice and video —
end-to-end encrypted, with the keys held on the device.

Built with React + TypeScript + Vite, TailwindCSS + daisyUI, and Supabase
(Auth, Postgres, Realtime, Storage). The browser build is a development
convenience; there is no hosted web deploy.

## Encryption

- Every message body, caption and attachment is sealed on the device. The server
  stores a ciphertext and a nonce and has no way to read either — `0023` dropped
  the plaintext column and the server-side search that depended on it
- Each account's key is derived from a 12-word recovery phrase, stored in
  Android's Keystore and never sent anywhere. Losing the phrase means losing the
  history: nobody can reset it
- Keys are per account, not per device. Two accounts on one phone each hold their
  own, and neither can read the other's messages
- Attachments get a random per-file key, sealed to the recipient alongside the
  message. Storage holds bytes it cannot interpret
- Search and conversation previews run against a local SQLite mirror of what this
  device has decrypted, one database file per account

## Features

- Email/password auth with a display name, editable later, and email password
  reset over an `app.nearside://` deep link
- Connecting by QR or by an eight-character code read aloud. There is no
  directory and no name search: `search_profiles()` is gone, display names
  collide freely, and nobody can be found by one. A code is single-use and
  expires in ten minutes; a scan also verifies the contact, because the key
  travelled in the QR
- Private friend nicknames: name someone whatever you like, visible only to you
  (they are never told), used in the sidebar, the chat header and notifications
- A note-to-self chat, pinned to the top of the list for every account — the
  full chat with media, voice notes, replies and reactions, minus the things
  that need a second person (presence, typing, ticks, notifications)
- Real-time 1:1 messaging with typing indicators
- Encrypted group rooms: one symmetric key per room, sealed once to each
  member's published key, and every message signed with the sender's Ed25519
  key. The signature is checked *before* the message is opened, and one that
  fails renders as a warning rather than being hidden
- Safety numbers, with a verified badge in the chat header and a blocked
  composer when a contact's key changes under you
- A "What the server knows" screen built from live queries against the real
  schema, plus a page that says plainly where the protection stops and names
  Signal for the people who should be using it instead
- Free local pinning: a pinned attachment is decrypted and written to
  app-private storage, and survives the server-side pruning that keeps
  storage costs down
- Cosmetic theme packs through RevenueCat. Nothing functional is behind a
  purchase, and no advertising SDK is in the build — `no-ads.test.ts` fails
  the suite if one appears
- Message edit and delete (soft delete)
- Image and video sharing (newest 20 media kept per conversation), with images
  re-encoded to WebP on the device before upload
- Voice messages up to 2 minutes: hold the mic on a phone, click it on a
  desktop (newest 50 kept per conversation)
- Camera capture from the attachment sheet on phones — photo or video, straight
  into the conversation
- Per-conversation chat background image, set independently by each user
- Avatar upload
- Message pagination (load older on demand)
- Android app (Capacitor). The service worker still exists for the browser build
  and is switched off in native builds — see the Android section
- Survives sleep, network loss and blocked WebSockets: the app detects wake
  (including on desktop, where nothing fires an event), rebuilds its realtime
  subscriptions, backfills whatever it missed, and falls back to polling while
  live delivery is down — with a banner saying so

## Notifications

Background notifications go through OneSignal, targeted by the Supabase user
id so a campaign reaches an account rather than a device. They carry who a
message is from and never what it says — after `0023` the server has no body
to read, so this is a property of the schema rather than a policy.

The Web Push (VAPID) transport is gone: `0028` drops `push_subscriptions`, and
`lib/push.ts`, `lib/vapid.ts` and the service worker's push handlers went with
it. Two transports competing for one tray entry was the bug.

## Connectivity notes

Realtime runs over a WebSocket. Some networks — corporate proxies, and a number
of routes reached through a VPN — stall or drop `wss://` while ordinary HTTPS
keeps working. When that happens the app keeps functioning on its polling
fallback (a few seconds' latency instead of instant), rather than appearing to
work while silently showing a frozen conversation.

If a whole region can't reach `*.supabase.co` at all, the fix is a custom
domain in front of the Supabase project (Supabase → Settings → Custom Domains)
plus `VITE_SUPABASE_URL` repointed at it. Domain-level blocks don't follow the
CNAME.

## Prerequisites

- Node.js 20.19+ (Vite 8 requirement)
- A Supabase project

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Supabase project, then in the SQL editor run, in order:

   - every file in `supabase/migrations/` in ascending numeric order
     (`0001_init.sql` … `0013_chat_backgrounds_per_user.sql`) — tables,
     RLS, triggers, realtime
   - `0014_server_side_push.sql` is optional and needs configuration before it
     does anything; see `supabase/SETUP.md`
   - `0015_voice_messages.sql` — the `audio` media kind and recorded length
   - `0016_friend_nicknames.sql` — private per-user nicknames
   - `0017_self_chat.sql` — the note-to-self conversation. Widens the message
     INSERT policy to allow addressing yourself, stops your own notes counting
     as unread, and adds your own row to `conversation_list()`
   - `0018` … `0021` — forwarding, open signup, identity keys, encrypted bodies
   - `0022_display_name.sql`, then `0023` … `0025` — the profile rename, the
     server losing message bodies, encrypted media, and sealed media MIME
   - `0022b_no_directory.sql` — applied **after** `0025`, deliberately. It
     drops `search_profiles()` and adds `connect_tokens` with its mint/redeem
     RPCs, so it may not run until the connect flow that replaces the
     directory works. The number records authorship order; this list records
     apply order
   - `0026_rooms.sql` — rooms, participants, sealed per-member keys, signed
     room messages, and `rooms_for_me()`
   - `0027_transparency.sql` — `public_table_names()`, so the transparency
     screen compares itself against the real schema instead of a hard-coded
     description that can go stale
   - `0028_drop_web_push.sql` — drops `push_subscriptions` along with the
     VAPID transport
   - `supabase/storage-setup.sql` — `avatars` and `chat-media` buckets + policies

3. In Supabase **Authentication → URL Configuration**, add your site URL and
   `/*` redirect so password-reset links return to the app.

   For the Android build, also add both deep-link targets to **Additional
   Redirect URLs** — GoTrue rejects any `redirect_to` that is not on this list,
   and the emailed link then falls back to the Site URL, which no phone can
   open:

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

| Command             | Purpose                     |
| ------------------- | --------------------------- |
| `npm run dev`       | Start the dev server        |
| `npm run build`     | Production build to `dist/` |
| `npm run preview`   | Preview the production build|
| `npm run typecheck` | TypeScript check, no emit   |
| `npm run lint`      | ESLint                      |
| `npm run android:sync` | Native build + copy into `android/` |
| `npm run android:open` | Open `android/` in Android Studio |

## Android

The Play build is a Capacitor shell around the same web app (`applicationId`
`app.nearside`). Requirements: the Android SDK (compile/target 36) and JDK 21 —
Gradle 8.14 does not run on newer JDKs.

```bash
npm run android:sync
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
```

`JAVA_HOME` has to be set explicitly wherever the system default JDK is newer
than 21 — Gradle fails at configuration time rather than with a version message.
Gradle finds the SDK through `android/local.properties`, which is gitignored and
holds a single line:

```properties
sdk.dir=/absolute/path/to/Android/Sdk
```

`android:sync` sets `NEARSIDE_NATIVE=1`, which disables the PWA service worker
for native builds: a Workbox precache inside a WebView keeps serving the
previous build after an app update.

Release builds run R8 (`minifyEnabled true`). Every Capacitor and Cordova
plugin is reached reflectively from the WebView bridge, so R8 sees no caller
for any of them — `android/app/proguard-rules.pro` is what keeps them, and a
missing rule shows up as a runtime crash rather than a build failure. Test a
release build on hardware, not just a debug one.

Two files are needed locally and are deliberately not in version control:
`android/app/google-services.json` (Firebase project `nearside-9459c`) and
`android/keystore.properties`, which points at the upload keystore:

```properties
storeFile=/absolute/path/to/nearside-upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

Release builds are unsigned without it; debug builds do not need it.

## Deploy

There is no hosted web deploy. The shipped artifact is the Android build, and
`npm run dev` covers local work — the browser build is a development
convenience, not a target, which is also why `isSecureStorageAvailable()` warns
that a browser cannot hold a key the way the app can.

One consequence worth knowing: emailed auth links redirect to
`app.nearside://auth/…` on the device (see `src/lib/authRedirect.ts`), so that
scheme has to be allow-listed in Supabase rather than a web origin.
`supabase/SETUP.md` covers it.
