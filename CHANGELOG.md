# Changelog

All notable changes to Nearside. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions are
[semantic](https://semver.org/spec/v2.0.0.html).

Entries say what changed for a user of the app, with the reason where the reason
is the interesting part.

The version lives in `package.json` and every other place that carries it — the
Android `versionName`, the iOS `MARKETING_VERSION`, the Electron shell, the
string in Settings — follows it. `src/lib/version.test.ts` fails the suite when
one of them drifts.

## [Unreleased]

### Fixed

- **An attachment that will not send now says why.** Every way a photo, video
  or voice message could fail arrived as the same four words — "Could not send
  media" — whether the file could not be read off the phone, the person you are
  writing to has never published an encryption key, the connection dropped
  halfway, or the server refused the row. Four problems with four different
  remedies, and nothing on screen to tell them apart. Each now comes back as a
  sentence naming the cause, and the underlying error is written to the device
  log so a report can carry it. The only send that still reads as generic is one
  that failed with nothing to say for itself.
- **A refused send no longer leaves the file behind.** The key that seals an
  attachment to its recipient was sealed *after* the bytes had already gone up,
  so anything that went wrong at that step — the commonest being a contact whose
  device has never published a key — left an encrypted file in storage that no
  message would ever point at, and nothing collects those. Everything that can
  refuse a send now happens before the upload, which also means the refusal is
  instant instead of arriving after a photo has been uploaded for nothing.
- **A file at exactly the size limit sends.** Encrypting a file makes it a few
  dozen bytes larger, and the ceiling is checked on what is uploaded, so a
  50 MB video was accepted by the composer and then rejected by the server after
  the whole upload had been spent. The composer now accounts for the difference.
- **A photo whose name has a bracket or a space in the wrong place sends.** The
  file's extension is reused when the attachment is saved, and a second copy of
  a download — `shot.jpg (1)` — carried the whole tail into the storage path,
  where it was refused outright. Nothing about that was explainable to the person
  trying to send the picture.

## [1.2.0] — 2026-08-17

### Changed

- **A conversation you are not watching gets heard.** Notifications used to
  make a sound once per conversation and then stay silent for thirty seconds,
  which stopped the phone buzzing through a burst of short messages but traded
  it for a worse problem: six messages arriving while the phone was in a pocket
  announced themselves once, and the next sound the app was allowed to make came
  half a minute later, after the conversation had moved on. Messages were being
  missed by people who installed the app so they would not be. The sound now
  steps back gradually instead — the first message rings, the next about five
  seconds later, the one after that fifteen, and from then on one every forty
  seconds for as long as the conversation goes unread. Everything in between
  still arrives in the shade and still counts; it just does not interrupt.
- **Reading a chat starts the sound over.** The old timer could not tell "still
  mid-sentence" from "caught up and put the phone down", so a reply arriving
  shortly after you had read a conversation landed in silence. Opening a chat
  now clears its quiet period, on the phone and on the server alike, and the
  next thing that arrives while you are elsewhere is heard at full volume. So is
  a message that follows five minutes of quiet, which is the end of a burst
  whether or not anybody read anything.
- **The notification request reads like a person wrote it.** The screen that
  appears once, after the account and the recovery phrase are done, asked to
  "get told when a message arrives" and explained itself in a sentence built
  around what would happen without it. It now says plainly that the app can only
  reach you while it is open, and what a notification carries: who wrote, and
  nothing more.

## [1.1.1] — 2026-08-17

### Fixed

- **Trimming old photos no longer deletes the other person's.** A conversation
  keeps its newest twenty pictures and clears the rest to keep the account's
  storage from growing without end. It was clearing both people's files but
  could only relabel its own messages, so the friend's photo lost its contents
  while the message still pointed at them — and every device in that
  conversation drew it as permanently lost, with nothing to distinguish it from
  a file the server had misplaced. Each phone now clears only what it sent, so a
  file and the message naming it always go together.

### Changed

- **An attachment that will not load says why.** "This file is no longer
  available" was shown for three different things: a file that really had been
  removed, a file this phone holds no key for, and a file this phone downloaded
  and decrypted perfectly but has no decoder for — an iPhone HEIC photo, most
  often, which arrives intact and cannot be painted. Only the first was a lost
  file, and the other two sent people looking for a picture that was never in
  danger. Each now reads as what it is.

## [1.1.0] — 2026-08-15

### Fixed

- **A call to a locked phone rings until it is answered.** It rang for about
  half a second and then went silent, leaving nothing in the notification shade
  and no way to answer but opening the app. The ring was cancelling itself: a
  full-screen intent starts the app *by itself* on a sleeping phone, and that
  launch arrived carrying the same "the user tapped the ring" marker as an
  actual tap, so the app took the ring down and recorded the call as dealt with
  — which then also stopped it ringing when the call proper arrived. A phone
  whose screen was on never saw any of it, because a phone in use gets a banner
  and no launch, which is why this only ever happened to a phone in a pocket.

### Changed

- **"Where this protection stops" names two limits about calls** it did not name
  before: a call reaches only the account the phone is signed into, and
  declining from the lock screen of a phone with the app closed silences your
  phone without always being able to tell the caller — sealing that message
  needs a key that is only reachable once the app is running.

## [1.0.0] — 2026-08-15

First complete version: everything below has shipped in an Android release build
running on hardware. The iOS project is configured but has never compiled, and
the browser and Electron builds are development conveniences rather than
shipping targets.

### Added

- **"In this conversation".** A panel behind the chat header listing the dates
  somebody named and the links somebody sent, each row jumping to the message it
  came from. Built by reading the decrypted copy already on this device — the
  server has no message bodies to index — so nothing is uploaded to produce it,
  and a conversation this device has never opened is honestly reported as empty
  rather than silently so.
- **Sealed exchange.** Ask a question and commit your own answer to it; neither
  side can read the other's until both have answered, and then both open at
  once. The withholding is a row-level policy on the server, not a check in the
  app — this repository is public, and a client-side check is one anyone can
  delete. The server holds two ciphertexts it cannot open and arbitrates only
  the order they are handed out in. Answers cannot be edited or withdrawn once
  sent, which is what stops reading first and revising after; a question can be
  withdrawn while it is still unanswered.
- **Voice and video calls.** Peer-to-peer WebRTC, answerable from the lock
  screen of a phone whose app the system has killed. SDP and ICE candidates are
  both sealed, and broadcast signalling leaves no row, so there is no record
  that a call happened.
- **Donation tiers** alongside the theme packs, and the Terms and Privacy Policy
  rendered in-app from one shared source of facts.
- **First-run invite card**, and `supabase/schema.sql` as a single-file view of
  the database.
- **Multi-photo send** — several images in one pass through the composer.
- **Disappearing messages**, keyed to the conversation rather than to one side's
  preference. The server stamps `expires_at`; `pg_cron` deletes; the device
  sweeps its mirror to match.
- **App lock.** A passphrase in front of the app and the local mirror, stretched
  with PBKDF2-HMAC-SHA256 at 600k iterations and verified against a per-account
  verifier in secure storage. The recovery phrase is the way back in.
- **`FLAG_SECURE` where it matters** via a small Android plugin, covering the
  recovery phrase and the lock screen — which also keeps them out of the recents
  thumbnail.
- **Safety numbers as a sigil and four spoken words**, so verification can be
  done over a call instead of by comparing sixty digits.
- **Group rooms**, one symmetric key per room sealed to each member, with an
  Ed25519 signature verified before decryption.
- **Encrypted media**, local pinning that survives server-side pruning, and
  voice notes with a live level meter.
- **Connect by QR or an eight-character code.** Single-use, ten-minute expiry,
  and a scan verifies the contact because the key travelled in the code.
- **The transparency screen** — what the server knows, and where the protection
  stops — built from live queries rather than hard-coded copy.
- **Cosmetic theme packs** through RevenueCat, nine themes, three free, with
  ownership by grant as well as by purchase.
- **OneSignal push**, carrying a sender and never content.
- **Two motion tiers** and a named elevation scale; the OS accessibility setting
  is stricter than either and wins.
- **iOS target** added and configured (CocoaPods, not SPM — the barcode scanner
  ships no `Package.swift` and an SPM project drops it silently).

### Changed

- **The server no longer stores or reads message bodies.** Migration `0023`
  dropped `messages.content` and the server-side search that read it. Search and
  conversation previews moved to a local SQLite mirror of what this device
  decrypted.
- **There is no directory.** `search_profiles()` was removed; nobody can be
  found by display name.
- Identity and the local mirror are scoped **per account**, after a device-wide
  key slot let a second account on the same phone inherit the first one's
  private key.
- `ChatRoom` split into hooks, which surfaced and fixed several bugs the single
  component had hidden.
- Comments across the codebase trimmed to the *why*.
- Licensed under **GPL-3.0**: a closed fork is a fork whose crypto nobody can
  check.

### Fixed

- Notifications were never initialised, and a silent recording looked like a
  successful one.
- Client `EXECUTE` revoked on trigger functions.
- Chrome kept clear of the system bars under mandatory edge-to-edge, on both
  WebView paths.
- Assorted media handling: microphone permission, captionless media, video
  posters, one save path to the gallery, and a QR scanner that could dead-end.

### Security

- No plaintext fallback anywhere: sealing throws when a peer has published no
  key rather than degrading.
- `src/lib/no-plaintext.test.ts` fails the build if a message body ever reaches
  an insert payload; `src/lib/no-ads.test.ts` fails it if an advertising SDK
  appears in `package.json` or the Gradle build.
- Release builds run R8 with keep rules for everything reached reflectively.

### Infrastructure

- CI runs `test`, `lint` and `typecheck` on every push and pull request.
- `npm run db:verify` replays the migrations against `schema.sql` in a
  throwaway Postgres container and diffs the catalogs, so a schema change made
  in only one of the two places fails locally rather than in production.
