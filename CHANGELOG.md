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

## [1.4.2] — 2026-08-17

### Fixed

- **The "Chats" and "Settings" titles now follow the app's language.** Both were
  written into the screen rather than looked up, so on a Spanish, German or
  Russian phone the two headings you see most often stayed in English while
  everything under them translated.

## [1.4.1] — 2026-08-17

### Security

- **Nearside is no longer included in Android backups.** Two things in the app's
  private storage are deliberately readable: attachments you pinned, and the
  local copy of messages this phone has decrypted, which is what makes search
  work offline. Both were being copied to Google Drive by the system backup —
  plaintext, to somebody else's servers, from an app whose whole claim is that
  the server holds nothing. They stay on the phone now. The cost is that a new
  phone starts at your recovery phrase rather than restoring itself, which is
  the honest position for an app that has no reset path.
- **Chat backgrounds are encrypted.** They were the one picture that went up in
  the clear, and they share a storage folder with the conversation's
  attachments — so the person you were talking to could have read the photo
  behind your thread, and so could the server. A background now gets its own key
  like every attachment does. Backgrounds set before this update keep working
  and are replaced the next time you choose one.
- **Photos no longer carry where they were taken.** A picture that gets resized
  on the way out has always lost its camera data as a side effect. One that did
  not — an animation, or a photo already small enough to send as-is — kept its
  GPS coordinates, and encryption does not hide those from the person receiving
  them. Now everything is cleaned before it is sent, except a photo whose
  rotation tag is the only thing keeping it the right way up. Videos still carry
  their metadata; that one is not fixed.

### Fixed

- **Animated pictures stay animated.** An animated WebP or PNG — which is what
  most saved "GIFs" and exported sticker packs actually are — was being
  flattened to its first frame on the way out, silently. GIFs were already
  exempt; the check now looks at the file instead of trusting its type.
- **A photo pasted into the message box while an upload was running no longer
  disappears.** It was being dropped when the upload finished.
- **A trimmed attachment can no longer become a photo that is gone with no
  explanation.** Conversations keep a fixed number of photos and voice notes and
  clear the rest, replacing each with a note saying so. If writing that note
  failed — most often because the other person's account was gone — the file had
  already been deleted, and the message was left pointing at nothing forever.
  The note is now written first.
- **Videos and voice notes recorded in some formats can be played again.** A
  file whose name arrived without an extension was given one that nothing could
  read back, and since an encrypted file says nothing about itself, that was the
  only record of what it was. Files already sent this way now open too.

## [1.4.0] — 2026-08-17

### Added

- **Nearside speaks Spanish, German and Russian.** Settings → Language, with
  "Match my device" as the default, so an install on a Spanish phone opens in
  Spanish rather than waiting to be told. The choice belongs to the phone rather
  than to an account: the sign-in screen belongs to nobody, and a roster of
  accounts each holding its own language would leave it with none. Changing it
  takes effect on the spot — nothing to reload, and the screen you were reading
  stays where it was.
- Dates, times, counts and file sizes follow the language too. A German app no
  longer prints an English month abbreviation beside a German sentence, and
  Russian counts read "1 сообщение / 3 сообщения / 5 сообщений" rather than
  taking English's one-or-many guess.

### Note

- The Terms of Service, the Privacy Policy and the open source licenses stay in
  English, and the language screen says so. They are legal documents, and a
  translation of one is not the one you agreed to.

## [1.3.0] — 2026-08-17

### Added

- **Chats can be pinned, muted or deleted from the list itself.** Swipe a row on
  a phone, or use the `⋯` menu on a desktop, for the same three actions. Pinned
  chats sit at the top of the list; muted ones stop making noise; deleting one
  ends the contact as well, because a "deleted" chat whose owner can still write
  to you is not deleted. Pins and mutes never leave the phone: a pin list is a
  ranking of who matters to you and a mute list is a list of people you are
  avoiding, and neither is something the server is told. On Android a muted
  chat's notification is discarded on the phone before it is displayed. The cost
  of not having a server-side mute list is that the message is delivered and then
  thrown away. The desktop app has no such hook and still rings.
- **Deleting a chat, or declining a request, hides that person's future
  requests.** Ending a contact stops them messaging you, but nothing stops them
  asking to be a contact again, twenty times an hour if they like. Their
  requests are now hidden on this device, and Settings → Privacy → Hidden
  requests lists everyone in that state with a way to undo it. It is not a
  block: there is no block list on the server, so nothing about who you are
  avoiding is recorded anywhere but this phone.
- **A voice message can be heard before it is sent.** The staged recording was a
  microphone icon and a duration, so the only thing you could check was that
  something had been recorded, not that it captured a pocket, the wrong room, or
  half a sentence. It is now a player: press play, listen, then send or throw
  it away.
- **Recording without holding the button.** Slide up from the microphone to lock
  the recording hands-free, then pause and resume as you go, so a two-minute
  message no longer means holding a thumb still for two minutes. Sliding away
  still discards it. A paused recording's timer stops with it, so the length on
  the message is the length of the audio.
- **Voice messages play at 1.5× and 2×.** The speed sits beside the scrubber and
  is remembered for the rest of the session, because someone speeding one
  message up is telling you how they listen.

### Fixed

- **The chat list stops saying "Encrypted message" about messages it can
  read.** A message is only decrypted when its conversation is open, so anything
  that arrived while you were elsewhere (on the list, in another chat, or with
  the app closed) reached the list sealed and the row said so. The list now
  opens the newest message of any conversation it cannot preview, one message
  rather than a page. Rows that genuinely cannot be opened on this device still
  say so, which is the honest case that wording was written for.
- **A half-typed message stays in the chat it was typed in.** On a tablet or
  desktop, where the list and the conversation are on screen together, switching
  to another person carried the draft across with you, one keystroke away from
  being sent to the wrong person. Drafts are now kept per conversation, and
  switching away and back brings yours with you. They are held in memory only:
  a message nobody has agreed to send should not outlive the app on disk.
- **A photo the phone cannot read is refused before it is sent, not after.**
  Some phones save a picture in a format they then describe as something else,
  a `.png` that is not one. Nothing on any device Nearside runs on can draw it,
  so it arrived in the conversation as "this photo's format can't be shown
  here" for everybody, including the person who sent it, at the one moment
  nobody could still do anything about it. The composer now refuses it while
  the original is still in your hands, and says to export it as a JPEG.
- **A picture that is perfectly fine stops being called unshowable.** Whether an
  attachment could be displayed was decided by counting how many times the
  image failed to appear, but the app drops decrypted attachments from memory
  when it needs the room, and doing that under a picture on screen looks exactly
  like a failure. Two of those and a photo was labelled unreadable for as long
  as the conversation stayed open. The app now asks the only question that
  settles it: it decodes the picture itself, once, when it arrives.
- **An attachment that will not send now says why.** Every way a photo, video
  or voice message could fail arrived as the same four words, "Could not send
  media", whether the file could not be read off the phone, the person you are
  writing to has never published an encryption key, the connection dropped
  halfway, or the server refused the row. Four problems with four different
  remedies, and nothing on screen to tell them apart. Each now comes back as a
  sentence naming the cause, and the underlying error is written to the device
  log so a report can carry it. The only send that still reads as generic is one
  that failed with nothing to say for itself.
- **A refused send no longer leaves the file behind.** The key that seals an
  attachment to its recipient was sealed *after* the bytes had already gone up,
  so anything that went wrong at that step, the commonest being a contact whose
  device has never published a key, left an encrypted file in storage that no
  message would ever point at, and nothing collects those. Everything that can
  refuse a send now happens before the upload, which also means the refusal is
  instant instead of arriving after a photo has been uploaded for nothing.
- **A file at exactly the size limit sends.** Encrypting a file makes it a few
  dozen bytes larger, and the ceiling is checked on what is uploaded, so a
  50 MB video was accepted by the composer and then rejected by the server after
  the whole upload had been spent. The composer now accounts for the difference.
- **A photo whose name has a bracket or a space in the wrong place sends.** The
  file's extension is reused when the attachment is saved, and a second copy of
  a download (`shot.jpg (1)`) carried the whole tail into the storage path,
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
