# Nearside

An end-to-end encrypted messenger for Android and iOS. One-to-one chats and
group rooms, with text, photos, video, voice notes and calls, the keys held on
the device and nothing readable on the server.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-lightgrey)
[![CI](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml/badge.svg)](https://github.com/PanzerPeter/Nearside/actions/workflows/test.yml)

## Why Nearside

**The server holds no message bodies.** Not encrypted-at-rest by the operator:
absent. Migration `0023` dropped the `content` column and the server-side search
that read it, so there is no column a plaintext could arrive in. The cost is
paid openly: search and previews read a local SQLite mirror of what *this
device* decrypted, so a conversation is unsearchable on a phone that never
loaded it.

**Nobody can look you up.** There is no directory, no phone number and no search
by name. You connect by scanning a QR code or reading an eight-character code
aloud, and the scan also verifies the contact, because the key travelled in the
QR. Display names collide freely and mean nothing.

**Privacy is not a tier.** Six decorative theme packs and donation tiers are the
entire revenue line. No advertising SDK is in the build, and a CI test fails if
one appears.

**The claims are checkable rather than written.** The repository is public, the
in-app transparency screen reads the live schema instead of reciting copy, and
two tests hold the line in CI: `no-plaintext.test.ts` fails if a body ever
reaches an insert payload, `no-ads.test.ts` fails if an ad SDK reaches
`package.json` or the Gradle build.

**It is not a Signal replacement**, and says so in the app. Metadata is not
encrypted: the server knows who talks to whom and when. If you are at serious
risk, use Signal.

React + TypeScript + Vite in a Capacitor shell, backed by Supabase. The browser
and Electron builds are development conveniences; the shipping targets are the
two native ones.

## What it does

**Chats.** Realtime 1:1 with typing indicators, read receipts, replies,
reactions, editing, soft delete, forwarding, drafts, per-chat mute, and a
note-to-self vault pinned to the top of the list.

**Rooms.** One symmetric key per room, sealed to each member, so adding someone
is one row rather than a re-encryption of the history. A message whose signature
fails renders as a warning rather than disappearing, because a dropped message
is an attack the user never learns about. `@` completes against the member list on the
device, since the mention travels inside the sealed body.

**Media.** Images re-encode to WebP on the device, which drops EXIF on the way;
an animated image, or one that would lose its orientation, passes through with
its metadata stripped instead. Video, and voice notes up to two minutes with a
live level meter. Cleanup is per conversation and client-side; pinning writes a
decrypted copy into app-private storage so it survives that.

**Stickers.** A personal library sealed under your vault key, label included.
Sending one takes the ordinary attachment path with a fresh key and a fresh
upload, because referencing a shared object would put "who sent which picture to
whom, and when" on the server for the one message type where the picture is the
whole message.

**Calls.** Peer-to-peer WebRTC, media keys from the DTLS handshake, so a TURN
relay in the path forwards SRTP it cannot read. Signalling is sealed
`crypto_box` over a Realtime broadcast topic, SDP and ICE alike, because a
candidate line carries the device's addresses. Broadcast leaves no row, so there
is no `calls` table and no record a call happened. A locked phone rings through
a full-screen notification and answering goes straight to "Connecting…".

**Trust.** Safety numbers, a verified badge in the header, and a blocked
composer when a contact's key changes. The app does not guess whether that was
a reinstall or an interception.

**Block and report.** A block is enforced by the database, not the app: no
message, edit, reaction, pin, timer change or call gets through in either
direction, while both people keep the history and the blocked side is told.
Each direction is its own row, so when both have blocked, one unblocking does
not reopen the conversation. A report is emailed to the team as a ticket, and
the reporter chooses whether to include the last 30 messages. That choice is
the only way a message body ever leaves a device in readable form, and the
database keeps a who-reported-whom row and none of the text.

**Sealed exchange.** A question carrying the asker's own answer, where neither
side reads the other's until both exist. The referee is the SELECT policy on
`sealed_answers`, not a client-side check. This repository is public, and a
check in the client is one anyone can delete.

**In this conversation.** A panel pulling the days somebody named and the links
somebody sent out of the local mirror. Every row keeps the exact phrase and
jumps to its message, and a phrase resolves against its own message's timestamp,
so a year-old "friday" does not land this week.

**Private nicknames and chat backgrounds.** Both sealed under your vault key, so
"only you can see this" is true of the server as well as the app. The other
person is never told.

**Disappearing messages.** Off, 5 minutes, an hour, a day, a week. The timer
belongs to the conversation, not to one side's preference: a per-user setting
would let one party keep a copy the other believed was gone. Screenshots are
still possible, and the app says so beside the setting.

**App lock and `FLAG_SECURE`.** A passphrase in front of the app and the mirror,
with the twelve words as the way back in. It is not a second layer of encryption
and does not claim to be. The recovery phrase and lock screens are kept out of
screenshots and the recents thumbnail, and the app is excluded from Android
backups, since the pinned files and the mirror are plaintext.

**Living with it.** Up to five accounts per phone, each with its own seed slot
and mirror. Eight languages, typed against English so a missing line fails
`npm run typecheck`. An IndexedDB outbox whose client-generated uuids make a
retry collide instead of double-sending. Reconnection on a doubling backoff, and
polling when a proxy blocks the WebSocket but leaves HTTPS alone.

## Encryption

Twelve words produce a seed. The seed is stored per account in Android's
Keystore or the iOS Keychain and never leaves the device. Three keys derive from
it through fixed context labels: a box key for peer messages, an Ed25519 signing
key, and a vault key for your own data.

| Sealed thing | Sealed with |
| --- | --- |
| Self-chat | `crypto_secretbox` under the vault key |
| One-to-one | `crypto_box` to the peer's published public key |
| Room | one room key sealed per member, plus an Ed25519 signature **verified before decryption**, since every member holds the room key and only the signature establishes authorship |
| Attachment | a random per-file key, uploaded as `application/octet-stream` with the nonce prepended, the key travelling sealed in the message row |
| Sticker, chat background, private nickname | the owner's vault key, label and nickname sealed alongside the file |

`src/lib/sealed-body.ts` is the only place a body is sealed or opened, and there
is no plaintext fallback: `sealBody` throws when a peer has published no key
rather than degrading, because a silent fallback would be invisible to the
sender.

Losing the twelve words loses the history. There is no reset path.

Primitives, the threat model and what is in scope for a report:
[SECURITY.md](SECURITY.md). The reasoning under every decision above:
[DESIGN.md](DESIGN.md).

## What it does not protect

The app ships a screen saying this too.

- The server knows who talks to whom, and when. Metadata is not encrypted.
- `display_name`, `bio`, `last_seen_at` and room titles are ordinary text
  columns. The nickname *you* give a contact is not one.
- A video keeps its capture timestamp; it sits in a structural part of the
  container. Location, device and GPS are stripped, and photos lose their EXIF.
- A relayed call passes through a TURN provider, which sees two addresses
  exchanging packets and not what was in them.
- A rooted or jailbroken phone can reach the seed. A compromised device is a
  compromised account.
- Removing someone from a room does not claw back what they already hold.
- A block covers one-to-one conversations. In a group you share with someone
  you blocked, their messages still reach you; leaving the group is the fix.
- A report with messages attached sends them to the team in readable form, by
  email. The app asks first, every time.

## Quick start

You need Node 22 and a Supabase project.

```bash
npm install
cp .env.example .env      # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm run dev
```

Server setup (schema, buckets, `pg_cron`, the auth redirect URLs and the five
edge functions) is in [`supabase/README.md`](supabase/README.md). Read it
before touching a live project: apply order is not numeric order, and
`npm run db:verify` is the dry-run.

Native builds need Android SDK 36 with JDK 21, or macOS with Xcode 15+ and
CocoaPods. `npm run android:sync` then `./gradlew assembleDebug`.
[docs/BUILDING.md](docs/BUILDING.md) covers signing, the R8 rules a missing entry
turns into a runtime crash, and the iOS project, which is configured but has
never been compiled. The Electron shell in `electron/` is a convenience build
with no Keystore, no local mirror and no QR scanning; see [commands.md](commands.md).

| Command | Purpose |
| --- | --- |
| `npm run dev` · `build` · `preview` | Dev server, production build, preview it |
| `npm run test` · `typecheck` · `lint` | vitest, tsc on both tsconfigs, ESLint |
| `npm run db:verify` | Replay migrations against `schema.sql` in Docker and diff |
| `npm run db:audit -- '<url>'` | Diff the **live** project against `schema.sql`, read-only |
| `npm run android:sync` · `ios:sync` | Native build into `android/` · `ios/` |
| `npm run electron:install` · `start` · `pack` | Desktop shell |

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
  lib/call/     session.ts (the peer connection), signaling.ts (sealed
                broadcast), state.ts + routing.ts (the interleavings, as pure
                functions), warmup.ts (capture that starts early)
  locales/      en, es, de, ru, hu, fr, pl, zh, each typed against en
supabase/       schema.sql, migrations/, storage/, functions/, verify/
android/        Capacitor shell, the mature target
ios/            Capacitor shell, configured but never compiled
electron/       Desktop shell, a convenience build
```

Four seams to know before changing anything:

- **`lib/sealed-body.ts`** is the only sealer/opener. Queries return rows still
  sealed; they open at the component boundary, the only layer holding both an
  identity and a peer key.
- **`lib/connection.ts`** owns wake detection and the `generation` counter.
  Every realtime subscriber keys its channel effect on it, so don't add
  per-hook wake logic.
- **`App.signOut`** and `releaseAccount()` tear down every per-account cache. A
  new one has to be added there or it leaks into the next account on the phone.
- **`index.css`** folds two safe-area mechanisms into `--safe-top` /
  `--safe-bottom`. Use those, never `env()`, or the fix works on half the fleet.

Themes, the two motion tiers, why the Tailwind `shadow-xl`/`shadow-2xl` classes
are banned, and the mark: [docs/APPEARANCE.md](docs/APPEARANCE.md).

## Testing

```bash
npm run test                                  # whole suite
npx vitest run src/lib/outbox.test.ts         # one file
npx vitest run -t 'never puts a message body' # one test by name
```

vitest in a **node** environment over `src/**/*.test.ts`. There is no DOM setup,
deliberately: logic that needs testing gets pushed out of components into
`src/lib/`, where it can be tested without a renderer.

Four tests guard a decision rather than a function. `no-plaintext.test.ts` and
`no-ads.test.ts` keep the store listing true by construction, `elevation.test.ts`
fails if a banned shadow class comes back, and `version.test.ts` fails when the
places carrying the version number drift apart.

## Contributing

Issues and pull requests are welcome. Before opening one:

- `npm run typecheck`, `npm run lint` and `npm run test` all pass.
- **Do not change** `BOX_CONTEXT`, `SIGN_CONTEXT` or `VAULT_CONTEXT` in
  `src/lib/crypto/keys.ts`. It invalidates every existing user's keys.
- A schema change is two edits, a migration and the same change folded into
  `schema.sql`. `npm run db:verify` fails if you do only one.
- A user-visible change gets a `CHANGELOG.md` entry written with it, saying what
  changed for someone using the app.
- Comments explain *why*, and usually name the failure the code prevents.

Bug reports go through the [issue form](.github/ISSUE_TEMPLATE/bug_report.yml),
which asks for the platform and the network conditions, because several bugs
here only appear on a reconnect. Never paste a recovery phrase, key or token
into one. Security problems go to a **private security advisory** rather than a
public issue; [SECURITY.md](SECURITY.md) says what is in scope.

This is a solo project on a competition deadline, so reviews may be slow and a
large unsolicited pull request may not be merged. Ask in an issue first.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE). Copyleft is deliberate:
a closed fork is a fork whose crypto nobody can check.
