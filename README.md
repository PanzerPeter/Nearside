# Nearside

An end-to-end encrypted messenger for Android and iOS. One-to-one chats and
group rooms, with text, photos, video, voice notes and calls. The keys live on
the device, and the server holds nothing it could read.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey)
[![CI](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml/badge.svg)](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml)

## Why Nearside

**The server holds no message bodies.** They are not encrypted at rest on the
server; they are absent. Migration `0023` dropped the `content` column and the
server-side search that read it, so there is nowhere for plaintext to arrive.
Search and conversation previews read a local SQLite copy of what this device
decrypted, which means a conversation is not searchable on a phone that never
loaded it.

**Nobody can look you up.** There is no directory, no phone number and no
search by name. You connect by scanning a QR code or reading out an
eight-character code, and the scan also verifies the contact, because the key
travels inside the QR code. Display names can collide and carry no authority.

**Privacy is not a paid tier.** Revenue comes from optional theme packs and
donations. There is no advertising SDK in the build, and a CI test fails if one
is added.

**The claims can be checked.** The repository is public, the in-app
transparency screen reads the live schema instead of reciting copy, and two
tests enforce the core promises: `no-plaintext.test.ts` fails if a message body
reaches an insert payload, and `no-ads.test.ts` fails if an ad SDK reaches
`package.json` or the Gradle build.

**It is not a Signal replacement**, and the app says so. Metadata is not
encrypted: the server knows who talks to whom and when. If you are at serious
risk, use Signal.

## Features

### Conversations

- Realtime 1:1 chat with typing indicators, read receipts, replies, reactions,
  editing, deletion, forwarding, drafts and per-chat mute.
- A note-to-self vault pinned to the top of the chat list, sealed under a key
  only you hold.
- Disappearing messages (5 minutes up to a week), set per conversation rather
  than per person, so one side cannot quietly keep what the other believes is
  gone.
- Sealed exchange: ask a question with your own answer attached, and neither
  side sees the other's answer until both exist. The database policy enforces
  this, not the client.
- An "In this conversation" panel listing the dates people mentioned and the
  links they sent, each one jumping back to its message. It is built on the
  device from the local copy.

### Groups

- One symmetric key per room, sealed to each member, with every message signed.
  A message whose signature fails shows a warning instead of vanishing.
- The owner can add contacts later and any member can rename the group. The
  thread shows who joined and who renamed it.
- Someone added later reads from the moment they joined. The add screen says
  that the server enforces this, since a shared key alone cannot.
- `@` mentions complete against the member list on the device, because the
  mention travels inside the encrypted message.

### Media and calls

- Photos are re-encoded to WebP on the device, which removes EXIF and location.
  Animated images and videos keep their format and have their metadata stripped
  in place.
- Voice notes up to two minutes, with a live level meter.
- A personal sticker library, encrypted label included. Each send is a fresh
  encrypted upload, so the server never learns who sent which sticker to whom.
- Peer-to-peer voice and video calls. Media keys come from the DTLS handshake,
  so a TURN relay forwards traffic it cannot read. Signalling is encrypted and
  sent over a broadcast channel, so no record of a call is stored.
- A locked phone rings through a full-screen notification, and answering goes
  straight to connecting.

### Trust and safety

- Safety numbers, a verified badge, and a blocked composer when a contact's key
  changes.
- Blocking is enforced by the database in both directions. Both sides keep the
  history. In a shared group, a blocked person's messages fold into one line
  and do not notify you.
- Reports go to the team as an email ticket. You choose whether to attach the
  last 30 messages, which is the only way a message body ever leaves a device
  in readable form.
- App lock with a passphrase, using the recovery phrase as the way back in. The
  recovery phrase and lock screens are kept out of screenshots and the recents
  view, and the app is excluded from Android backups.

### Everyday use

- Up to five accounts per phone, each with its own key slot and local database.
- Eight languages (English, German, Spanish, French, Hungarian, Polish, Russian,
  Chinese), including notifications.
- Private nicknames and chat backgrounds, encrypted under your own key, so
  "only you can see this" holds for the server too.
- Nine themes, three of them free, with a split chat-list view on tablets and a
  centred reading column on wide screens.
- A built-in QR scanner that reads the camera on the device, with no Google
  Play Services involved.
- Unsent messages wait in an outbox and retry without duplicates. The app
  reconnects on its own and falls back to polling when a proxy blocks
  WebSockets.
- Screen reader support, including announcements for incoming messages.

## Encryption

A twelve-word recovery phrase produces a seed, stored per account in the
Android Keystore or the iOS Keychain. It never leaves the device. Three keys are
derived from it with fixed context labels: a box key for peer messages, an
Ed25519 signing key, and a vault key for your own data. All primitives come from
libsodium.

| Data | Sealed with |
| --- | --- |
| Note-to-self | `crypto_secretbox` under the vault key |
| 1:1 message | `crypto_box` to the peer's published public key |
| Room message | The room key, sealed once per member, plus an Ed25519 signature verified before decryption |
| Attachment | A random per-file key; the nonce is prepended to the upload and the key travels sealed in the message |
| Sticker, chat background, nickname | The owner's vault key |

`src/lib/sealed-body.ts` is the only place a message is sealed or opened. There
is no plaintext fallback: sending throws when a peer has no published key,
because a silent downgrade would be invisible to the sender.

Losing the recovery phrase means losing the history. There is no reset.

[SECURITY.md](SECURITY.md) covers the primitives, the threat model and how to
report a vulnerability. [DESIGN.md](DESIGN.md) explains the reasoning behind
each decision.

## Where the protection stops

The app shows this list on its own screen as well.

- The server knows who talks to whom and when, and last-seen times while
  Online status is on. Names, bios, profile pictures, group names, reaction
  emoji and the nickname you give a contact are encrypted.
- A view-once photo is deleted from the server after it is opened, but a
  modified app could keep it and a camera can photograph the screen.
- There is no forward secrecy. Messages are sealed between long-lived identity
  keys, so a seed obtained later opens recorded traffic.
- A rooted or jailbroken phone can reach the seed.
- A video keeps its capture timestamp, which sits in a structural part of the
  file. Location and device details are removed.
- A relayed call passes through a TURN provider, which sees two addresses
  exchanging packets but not their content.
- Removing someone from a room does not take back what they already have, and
  the room key is not rotated. Newcomers are kept from older messages by the
  server, not by the cryptography.
- Blocking covers 1:1 chats. In a group you share, the blocked person's
  messages still reach your phone, folded away. Leaving the group stops them.
- A report with messages attached sends them to the team in readable form. The
  app asks every time.

## Getting started

Requirements: Node 22 and a Supabase project.

```bash
npm install
cp .env.example .env      # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Server setup (schema, storage buckets, `pg_cron`, auth redirect URLs and the
edge functions) is in [supabase/README.md](supabase/README.md). Read it before
touching a live project: migrations are not applied in numeric order, and
`npm run db:verify` is the dry run.

### Platforms

- **Android** is the mature target. It needs Android SDK 36 and JDK 21:
  `npm run android:sync`, then `./gradlew assembleDebug` in `android/`.
- **F-Droid**: a separate build from the same source with no Google or other
  closed-source libraries. It has no push notifications or theme packs. `scripts/fdroid-prebuild.sh` prepares it.
- **iOS** needs macOS with Xcode 15+ and CocoaPods. CI compiles an unsigned
  build for sideloading ([docs/IOS-SIDELOAD.md](docs/IOS-SIDELOAD.md)); it has
  not yet been tested on a real iPhone.
- **Browser and desktop** (Electron, see [commands.md](commands.md)) are
  development builds. They lack secure key storage and the local database.

[docs/BUILDING.md](docs/BUILDING.md) covers signing, the R8 keep rules (a
missing one is a runtime crash, not a build error) and the iOS project.

### Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `preview` | Dev server, production build, preview |
| `npm run test` / `typecheck` / `lint` | Vitest, TypeScript on both configs, ESLint |
| `npm run db:verify` | Replay migrations against `schema.sql` in Docker and diff |
| `npm run db:audit -- '<url>'` | Diff the live database against `schema.sql`, read-only |
| `npm run android:sync` / `ios:sync` | Build the web app into `android/` or `ios/` |
| `npm run electron:install` / `start` / `pack` | Desktop shell |

## Project layout

```
src/
  components/   UI; settings/ holds one file per settings page
  hooks/        useChatThread (the conversation hub), useCall (calls, app-wide)
  lib/          Testable logic: crypto/, sealed-body.ts, message-queries.ts,
                localdb.ts (local SQLite copy), connection.ts, rooms.ts
  lib/call/     Peer connection, encrypted signalling, call state as pure functions
  locales/      Translations, each typed against en so a missing string fails typecheck
supabase/       schema.sql, migrations/, storage/, functions/, verify/
android/        Capacitor shell
ios/            Capacitor shell
electron/       Desktop shell
docs/           Building, appearance, sideloading
```

A few things to know before changing code:

- `lib/sealed-body.ts` is the only sealer and opener. Queries return rows still
  sealed, and they are opened at the component boundary.
- `lib/connection.ts` detects wake-ups and bumps a `generation` counter that
  every realtime subscription keys on. Don't add per-hook reconnect logic.
- `App.signOut` and `releaseAccount()` clear every per-account cache. A new
  cache has to be added there, or it leaks into the next account.
- Use `--safe-top` / `--safe-bottom` from `index.css`, never `env()` directly,
  or the safe-area fix works on only half of Android devices.

Themes, motion and elevation are documented in
[docs/APPEARANCE.md](docs/APPEARANCE.md).

## Testing

```bash
npm run test                                  # whole suite
npx vitest run src/lib/outbox.test.ts         # one file
npx vitest run -t 'never puts a message body' # one test by name
```

Tests run in Vitest's Node environment over `src/**/*.test.ts`. There is no DOM
setup by design: logic that needs testing moves out of components into
`src/lib/`.

Some tests guard a decision rather than a function. `no-plaintext.test.ts` and
`no-ads.test.ts` keep the store listing true, `elevation.test.ts` blocks banned
shadow classes, and `version.test.ts` fails when the six places holding the
version number drift apart.

## Contributing

Issues and pull requests are welcome. Before opening one:

- Make sure `npm run typecheck`, `npm run lint` and `npm run test` pass.
- Never change `BOX_CONTEXT`, `SIGN_CONTEXT` or `VAULT_CONTEXT` in
  `src/lib/crypto/keys.ts`. That invalidates every existing user's keys.
- A schema change is two edits: a new migration and the same change in
  `schema.sql`. `npm run db:verify` fails if only one is made.
- A user-visible change needs a [CHANGELOG.md](CHANGELOG.md) entry describing
  what changed for someone using the app.
- Comments explain why, usually by naming the failure the code prevents.

Report bugs through the [issue form](.github/ISSUE_TEMPLATE/bug_report.yml). It
asks for the platform and network conditions, because several bugs only show
up on reconnect. Never paste a recovery phrase, key or token into an issue.
Security problems go to a private security advisory; [SECURITY.md](SECURITY.md)
says what is in scope.

This is a solo project, so reviews can be slow. For anything large, open an
issue first.

## License

[GNU General Public License v3.0](LICENSE). The copyleft is deliberate: a
closed fork would be one whose cryptography nobody can check.
