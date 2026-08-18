# Nearside

An end-to-end encrypted messenger for Android and iOS. One-to-one chats and
group rooms, with text, photos, video and voice notes, the keys held on the
device and nothing readable on the server.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey)
[![CI](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml/badge.svg)](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml)

React + TypeScript + Vite, wrapped in Capacitor, backed by Supabase for auth,
Postgres, realtime and storage. The browser and Electron builds are development
conveniences; the shipping targets are the two native ones.

- [Four decisions that shaped it](#four-decisions-that-shaped-it)
- [Encryption](#encryption)
- [Features](#features)
- [Where the protection stops](#where-the-protection-stops)
- [How it makes money](#how-it-makes-money)
- [Quick start](#quick-start) · [Scripts](#scripts) · [Builds](#builds)
- [Code tour](#code-tour) · [Testing](#testing) · [Contributing](#contributing)

Longer reading: [DESIGN.md](DESIGN.md) for why it is built this way,
[SECURITY.md](SECURITY.md) for the threat model and how to report a
vulnerability, [CHANGELOG.md](CHANGELOG.md) for what has landed,
[docs/APPEARANCE.md](docs/APPEARANCE.md) for themes and motion,
[docs/BUILDING.md](docs/BUILDING.md) for the native builds, and
[commands.md](commands.md) for the emulator and desktop workflow.

## Four decisions that shaped it

**The server has no message bodies.** Migration `0023` dropped the `content`
column and the server-side search that read it; Postgres holds a ciphertext and
a nonce. Search and conversation previews run against a local SQLite mirror of
what *this device* decrypted, one database file per account. The trade is
visible and accepted: a conversation is unsearchable on a phone that never
loaded it.

**There is no directory.** `search_profiles()` is gone. Display names collide
freely and nobody can be found by one. You connect by scanning a QR code or
reading an eight-character code aloud, and a scan also *verifies* the contact,
because the key travelled in the QR. Codes are single-use and expire in ten
minutes.

**Notifications carry a sender, never a message.** Not as a policy, as a
consequence: after `0023` the push function has no body it could leak.

**The privacy claims are checked, not written.** The in-app transparency screen
reads the real schema through `public_table_names()` instead of reciting copy
that can go stale. Two tests hold the line in CI: `no-plaintext.test.ts` fails if
a body ever reaches an insert payload, `no-ads.test.ts` fails if an advertising
SDK appears in `package.json` or the Gradle build.

## Encryption

Twelve words produce a seed. The seed is stored in Android's Keystore or the iOS
Keychain, **per account**, and never leaves the device. Three keys derive from it
through fixed context labels: a box key for peer messages, an Ed25519 signing
key, and a vault key for your own data.

| Sealed thing | Sealed with |
| --- | --- |
| Self-chat | `crypto_secretbox` under the vault key |
| One-to-one | `crypto_box` to the peer's published public key |
| Room | one symmetric room key, sealed once per member, plus an Ed25519 signature **verified before decryption**. Every member holds the room key, so only the signature establishes authorship |
| Attachment | a random per-file key; uploaded as `application/octet-stream` with the nonce prepended, the file key travelling sealed in the message row |
| Sticker library, chat background | under the owner's vault key — file and label both, so neither the picture nor its name sits in Postgres in the clear |

`src/lib/sealed-body.ts` is the only place a body is sealed or opened, and there
is no plaintext fallback anywhere: `sealBody` throws when a peer has published no
key rather than degrading, because a silent fallback would be invisible to the
sender and would falsify the product's central claim.

Losing the twelve words loses the history. There is no reset path.

## Features

- **Messaging.** Realtime 1:1 with typing indicators, read receipts, replies,
  reactions, editing, soft delete, forwarding, drafts, per-chat mute, and a
  note-to-self vault pinned to the top of the list.
- **Group rooms.** One key per room, sealed to each member; adding a member is
  one row, not a re-encryption of the history. A message whose signature fails
  renders as a *warning* rather than being hidden, because a dropped message is
  an attack the user never learns about.
- **Media.** Images re-encoded to WebP on the device, which drops EXIF on the
  way; an animated image or one that would lose its orientation passes through
  as-is with its metadata stripped instead. Video, plus voice notes up to two
  minutes with a live level meter. Cleanup is client-side and per conversation —
  the newest 20 photos/videos and 50 voice notes stay on the server, older
  objects go on upload and when a chat reopens. Pinning writes a decrypted copy
  into app-private storage so it survives that, and pinning is free.
- **Stickers.** A personal library, sealed under your vault key. Sending one
  takes the ordinary attachment path — fresh key, fresh upload — rather than
  referencing a shared object, which would put "who sent which picture to whom,
  and when" on the server for the one message type where the picture is the
  whole message.
- **Voice and video calls.** Peer-to-peer WebRTC: the media keys come out of a
  DTLS handshake between the two phones, so a TURN relay in the path forwards
  SRTP it cannot read. Signalling is sealed `crypto_box` over a Realtime
  broadcast topic — SDP and ICE candidates both, because a candidate line carries
  the device's addresses — and broadcast leaves no row, so there is no `calls`
  table and no record that a call happened. A locked phone rings through a
  full-screen notification, and answering it from the lock screen goes straight
  to "Connecting…": the caller's topic is joined from the notification rather
  than after the friend list loads, the answering phone asks for the offer
  instead of waiting for the next repeat of it, and the TURN credentials and the
  microphone are opened during the wait rather than after it.
- **Trust.** Safety numbers, a verified badge in the header, and a blocked
  composer when a contact's key changes. The app does not guess whether that was
  a reinstall or an interception.
- **Sealed exchange.** A question carrying the asker's own answer, where neither
  side reads the other's until both exist. The rule is the SELECT policy on
  `sealed_answers`, not a client-side check — this repository is public, and a
  check in the client is one anyone can delete.
- **In this conversation.** A panel that pulls the days somebody named and the
  links somebody sent out of the local mirror. Every row keeps the exact phrase
  and jumps to its message; a phrase resolves against its own message's
  timestamp, so a year-old "friday" does not land this week.
- **Private nicknames.** The other person is never told, and the name follows
  them into the sidebar, the header and your notifications.
- **Disappearing messages.** Off, 5 minutes, an hour, a day, a week. The timer
  belongs to the *conversation*, not to one side's preference: a per-user setting
  would let one party keep a copy the other believed was gone. The server stamps
  `expires_at` in a trigger and `pg_cron` deletes; the device sweeps its mirror
  to match. Screenshots are still possible, and the app says so beside the
  setting.
- **App lock.** A passphrase in front of the app and the local mirror, with the
  twelve words as the way back in. It is not a second layer of encryption and
  does not claim to be; the seed is already in the Keystore. It stops someone who
  picks up an unlocked phone.
- **`FLAG_SECURE` where it matters.** A small Android plugin covers the recovery
  phrase and the lock screen, which also keeps them out of the recents thumbnail.
  The app is excluded from Android backups for the same reason: the pinned files
  and the decrypted mirror are plaintext, and a system backup copies both to
  somebody else's servers.
- **Several accounts on one phone.** Up to five, each with its own seed slot,
  mirror and lock. Switching tears down every per-account cache first, so a
  peer-key cache cannot follow one account into the next.
- **Four languages.** English, Spanish, German and Russian, following the phone
  by default. Catalogs are typed against the English one, so a missing line
  fails `npm run typecheck` rather than reaching a phone.
- **Chat backgrounds.** Per person and per conversation; your choice and your
  peer's are separate rows and separate objects. Sealed under your vault key,
  because the folder is shared with the conversation's attachments and an
  unsealed one would have been readable by the person you were talking to.
- **Survives bad networks.** Wake is detected from three signals (including a
  wall-clock jump, the only one that fires on a woken desktop), and one
  `generation` counter rebuilds every realtime subscription. When the WebSocket
  is blocked but HTTPS still works, as on some corporate proxies and VPN routes,
  the app polls instead of showing a frozen conversation, and reconnects itself
  on a doubling backoff without a banner or a retry button.
- **Durable outbox.** Unsent messages persist to IndexedDB with client-generated
  uuids, so a retry after a lost response collides on the primary key instead of
  writing a second copy.
- **Two motion tiers.** Expressive by default, **Reduce motion** in Settings for
  short fades. The OS accessibility setting is stricter than either and wins.

## Where the protection stops

The app ships a screen that says this too. In short:

- The server knows who talks to whom, and when. Metadata is not encrypted.
- `profiles.display_name`, `last_seen_at`, room titles and the nicknames you
  give contacts are ordinary text columns.
- Video metadata is not stripped. Photos lose their EXIF on the way out; there
  is no cheap way to rewrite MP4 atoms on the device, and this is the gap.
- A call that cannot find a direct path is relayed by a TURN provider, which
  sees that two addresses exchanged packets and not what was in them. The
  credentials are minted per call with a short life, and the transparency screen
  names the provider.
- A compromised device is a compromised account. The seed lives in hardware
  storage, but a rooted or jailbroken phone can reach it.
- Removing someone from a room does not claw back what they already hold.
- **This is not a Signal replacement.** If you are at serious risk, use Signal.
  The app says this in the same words.

## How it makes money

Cosmetics and voluntary support, both through RevenueCat: six decorative theme
packs sold once each, and donation tiers that buy nothing the app does. That is
the whole revenue line. Nothing functional sits behind a purchase and there is no
advertising SDK in the build. The default theme, light mode and OLED black are
free, because charging for a screen someone can read outdoors would be a
functional paywall wearing a cosmetic label. From the header of
`src/lib/purchases.ts`:

> A privacy product that paywalls privacy has sold the thing it claims to
> defend.

Store and entitlement setup lives in [docs/APPEARANCE.md](docs/APPEARANCE.md).

## Quick start

**Prerequisites.** Node 22 (CI runs it; Vite 8 needs 20.19 at minimum) and a
Supabase project. Android builds also need SDK 36 and JDK 21; iOS builds need
macOS with Xcode 15+ and CocoaPods.

```bash
npm install
cp .env.example .env      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev
```

Then, on the Supabase side:

1. **Build the schema.** On a fresh project, run
   [`supabase/schema.sql`](supabase/schema.sql) then
   [`supabase/storage/setup.sql`](supabase/storage/setup.sql) in the SQL editor
   — one file for the whole database, with no dead columns and nothing to
   replay in the right order.

   To bring an *existing* project forward instead, apply
   [`supabase/migrations/`](supabase/migrations/) by hand in the order given by
   `apply-order.txt`, and read
   [`supabase/migrations/README.md`](supabase/migrations/README.md) first. Two
   warnings that cost real time: **apply order is not numeric order**
   (`0022b_no_directory.sql` goes after `0025`), and later files supersede parts
   of earlier ones, so re-running an early file can revert a later one.

   `npm run db:verify` proves the two paths produce the same database, by
   building both in a throwaway Postgres container and diffing their catalogs.
   It needs Docker and nothing else, and is the safe place to dry-run a new
   migration before pasting it into an editor with no undo.
2. **Enable `pg_cron`** (Database → Extensions) and schedule the expiry sweep;
   the statement is at the bottom of `schema.sql`. Without it, disappearing
   messages vanish from the device on schedule but stay in Postgres.
3. **Authentication → URL Configuration**: add your site URL and a `/*` redirect
   so password-reset links come back. For native builds add both deep links to
   **Additional Redirect URLs**. GoTrue rejects any `redirect_to` not on the
   list, and the emailed link then falls back to the site URL, which no phone can
   open:

   ```
   app.nearside://auth/confirm
   app.nearside://auth/recovery
   ```
4. **Deploy the push function** (optional; inert until configured):

   ```bash
   supabase functions deploy send-push --no-verify-jwt
   supabase secrets set ONESIGNAL_APP_ID=... ONESIGNAL_REST_API_KEY=...
   ```

   The REST key is server-side only. Vite inlines every `VITE_`-prefixed variable
   into the bundle, so putting it in `.env` would publish it inside every APK.
5. **Deploy the call functions** (optional; calling degrades without them):

   ```bash
   supabase functions deploy call-ring
   supabase functions deploy call-ice
   supabase secrets set CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=...
   ```

   `call-ring` is the push that wakes a locked phone — without it a call only
   reaches a friend who already has the app open. `call-ice` mints short-lived
   TURN credentials per call; without it calls fall back to STUN alone and the
   ones behind carrier-grade NAT do not connect. A long-lived TURN secret in the
   bundle would be a free relay for anyone who unzips the APK, which is why it
   is minted server-side and never shipped.

`delete-account` is the fourth function and needs no configuration.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build |
| `npm run test` | vitest suite |
| `npm run typecheck` | tsc on both tsconfigs, no emit |
| `npm run lint` | ESLint |
| `npm run db:verify` | Replay migrations against `schema.sql` in Docker and diff |
| `npm run android:sync` · `android:open` | Native build into `android/`; open Android Studio |
| `npm run ios:sync` · `ios:open` | Native build into `ios/`; open Xcode (macOS) |
| `npm run electron:install` · `electron:start` · `electron:pack` | Desktop shell: install once, run, package |

## Builds

```bash
npm run android:sync
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
```

`JAVA_HOME` must be pinned to 21. Gradle 8.14 fails at configuration time on a
newer JDK without a useful message. The sync sets `NEARSIDE_NATIVE=1`, which
disables the PWA service worker — a Workbox precache inside a WebView keeps
serving the previous build after an app update. Release builds run R8, and every
plugin is reached reflectively, so `android/app/proguard-rules.pro` is the only
thing keeping them; test a release build on hardware.

The iOS project is configured but has **never been compiled**, and nothing in
`ios/` can be built from a Linux checkout. Signing, the Xcode capabilities that
have to be added by hand, export compliance, and the macOS options are all in
[docs/BUILDING.md](docs/BUILDING.md).

The Electron shell in `electron/` keeps its own `package.json` and
`node_modules`, deliberately outside the root install. It is a convenience
build, not a third shipping target: `cap sync` finds no plugin with an Electron
implementation, so the seed sits in localStorage rather than a Keystore, and the
local mirror, offline search, notifications, purchases and QR scanning are all
absent. Messaging, calls, media and the sealed exchange work.
[commands.md](commands.md) has the full list, and why launching it from a VS
Code terminal exits silently.

## Code tour

```
src/
  components/   UI. ChatRoom is a shell; the work lives in hooks/.
                settings/ holds one file per settings page
  hooks/        useChatThread is the conversation hub, composing the outbox,
                receipts and scroll position; useCall owns calls app-wide
  lib/          Everything testable: crypto/, sealed-body.ts (the seal
                boundary), message-queries.ts (returns rows still sealed),
                localdb.ts (the local SQLite mirror), connection.ts (wake and
                the generation counter), rooms.ts, stickers.ts, purchases.ts
  lib/call/     A call end to end: session.ts (the peer connection),
                signaling.ts (sealed broadcast), state.ts + routing.ts (the
                interleavings, as pure functions), warmup.ts (capture that
                starts before the call needs it)
  locales/      en, es, de, ru — typed against en
supabase/
  schema.sql    The whole database as it stands. One file, for a fresh project
  migrations/   How it got there. Applied by hand, in apply-order.txt's order
  storage/      Buckets and their policies
  functions/    send-push, delete-account, call-ring, call-ice (Deno)
  verify/       npm run db:verify — replays both paths and diffs them
android/        Capacitor shell, the mature target
ios/            Capacitor shell, configured but never compiled
electron/       Desktop shell, a convenience build
```

Four seams are worth knowing before changing anything:

- **`lib/sealed-body.ts`** is the only sealer/opener. `message-queries.ts`
  returns rows *still sealed*; they are opened at the component boundary, the
  only layer holding both an identity and a peer key.
- **`lib/connection.ts`** owns wake detection and the `generation` counter. Every
  realtime subscriber keys its channel effect on that number, so don't add
  per-hook wake logic.
- **`App.signOut`** and `releaseAccount()` tear down the outbox, pins, the local
  mirror, the peer-key and room-key caches, the OneSignal id and the RevenueCat
  login. Any new per-account cache has to be added there, or it leaks into the
  next account on the phone.
- **`index.css`** folds two different safe-area mechanisms into
  `--safe-top` / `--safe-bottom`. Use those, never `env()` directly, or the fix
  works on only half the fleet.

Design decisions behind the look, including theme packs, the two motion tiers,
why the Tailwind `shadow-xl`/`shadow-2xl` classes are banned, and the mark, are
in [docs/APPEARANCE.md](docs/APPEARANCE.md).

## Testing

```bash
npm run test                                  # whole suite
npx vitest run src/lib/outbox.test.ts         # one file
npx vitest run -t 'never puts a message body' # one test by name
```

vitest in a **node** environment over `src/**/*.test.ts`. There is no DOM or
component setup, deliberately: logic that needs testing gets pushed out of
components and into `src/lib/`, where it can be tested without a renderer.

Four tests guard a decision rather than a function. `no-plaintext.test.ts` and
`no-ads.test.ts` keep the store listing true by construction, `elevation.test.ts`
fails if a banned Tailwind shadow class comes back — the banding it causes is
invisible on a desktop and obvious on a phone — and `version.test.ts` fails when
any of the places carrying the version number drift apart.

## Contributing

Issues and pull requests are welcome. Before opening one:

- Comments explain *why*, and usually name the failure the code prevents. A
  comment restating the line below it does not belong.
- `npm run typecheck`, `npm run lint` and `npm run test` are all expected to
  pass.
- **Do not change** `BOX_CONTEXT`, `SIGN_CONTEXT` or `VAULT_CONTEXT` in
  `src/lib/crypto/keys.ts`. It invalidates every existing user's keys.
- A schema change is two edits — a migration and the same change folded into
  `schema.sql` — and `npm run db:verify` fails if you do only one.
- A user-visible change gets a `CHANGELOG.md` entry written with it, in the same
  register as the code comments: what changed for someone using the app.
- Privacy claims in the UI are built from live queries and real schema. Keep them
  checkable.

Bug reports go through the [issue form](.github/ISSUE_TEMPLATE/bug_report.yml),
which asks for the platform and the network conditions because several bugs here
only appear on a reconnect. Never paste a recovery phrase, a key or a token into
one.

Found a security problem? Open a **private security advisory** on the repository
rather than a public issue — [SECURITY.md](SECURITY.md) says what is in scope
and what the app already admits to.

This is a solo project built for a competition deadline, so reviews may be slow
and a large unsolicited pull request may not be merged. Ask in an issue first.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

Copyleft is deliberate here: anyone shipping a modified Nearside has to publish
their changes, which matters more than usual for an encrypted messenger. A closed
fork is a fork whose crypto nobody can check.
