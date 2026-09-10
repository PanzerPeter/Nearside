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

## [1.10.0] — 2026-09-10

### Added

- **Groups are searchable, and the group list says what was last said.** The
  server has held no message bodies since it stopped being able to read them, so
  a conversation is searchable on a device that decrypted it and nowhere else.
  Groups were simply never written into that local copy; now they are. A group
  this phone has never opened still shows its member count, which is the honest
  answer rather than a blank line.
- **A search result in a group jumps to its message**, loading the pages in
  between so the thread arrives whole instead of with a hole around the hit.
- **A "new messages" line** marks where you stopped reading, in conversations
  and groups. It is placed once, when you open the thread, and stays there while
  you read rather than chasing the newest message down the screen.
- **Read receipts, the typing indicator and your online status can each be
  switched off** (Settings › Privacy). Each switch works both ways: turn one off
  and you stop seeing that signal from other people too — the alternative is
  watching somebody who cannot watch you. Read receipts are enforced by the
  server, not by this app politely not looking: with them off, nobody you talk
  to can read your read marks at all.

### Changed

- With online status off, people show no dot rather than a grey one — grey means
  "offline", which is a claim about them.
- Search results now name whoever wrote the message, which in a group of six is
  the difference between a result list and a list of guesses.
- The result count and a few small strings around search and message editing are
  translated; they had been English in every language.

### Fixed

- Deleting a group message now also removes it from this device's copy, so it
  stops appearing in search and in the group list's last line. Editing one
  replaces the words there instead of leaving the old ones findable.

## [1.9.0] — 2026-09-10

### Added

- **Groups can be read all the way back.** A group used to show only its newest
  fifty messages, with no way to reach the fifty-first; older messages now load
  a page at a time without the view jumping under you.
- **Groups show what you have not read.** The group list carries an unread count
  per group, and opening one clears it on every device you are signed in on.
- **You can edit and delete your own group messages.** A deleted one leaves the
  note every other conversation leaves, in its place in the thread, and the
  correction reaches everybody else's phone as it happens rather than the next
  time they open the group.
- **A group tells you who is typing, by name.** Three dots in a group of six say
  nothing about who is about to speak.
- **Attachments can be kept on this device after the server lets them go.** The
  server trims old files; Settings › Storage now decides what this phone holds
  on to anyway — nothing, photos and voice notes, or those plus video. Only what
  you actually opened is kept, so it costs storage and never data. A
  disappearing message is never kept, whatever the setting says: it was sent on
  the understanding that it would go.
- **Conversations can be archived, and marked unread.** The shelf keeps the
  everyday list short without ending anything, and a conversation you read on
  the bus but cannot answer yet stops looking answered.
- **The chat list says when you left something half-written**, so an unsent
  reply is not something you have to remember.
- **Stickers can be dragged into the order you want them in.**

### Changed

- **Rooms are called groups** throughout the app, which is what everybody
  already called them.
- A message that fails to send is now kept, with Retry and Discard beside it.
  Before, the app gave up after a few attempts and threw the text away — and if
  you had moved to another conversation, without telling you.
- The Terms and the Privacy Policy now give the same minimum age. They
  disagreed, which is worse than either answer.
- The emoji picker follows the theme you chose in the app rather than always
  drawing itself dark, and it offers skin tones.

### Fixed

- **The menu on a row in the friend list is no longer clipped** to a sliver by
  the row it belongs to. It also works from the keyboard now — arrows, Home,
  End, Escape, and focus back where it started.
- Parts of the app that were still in English regardless of the language you
  chose are translated. A test now fails the build when new English is typed
  straight into the interface.

## [1.8.1] — 2026-09-10

### Changed

- With a mouse and keyboard, the emoji picker now stays open after you pick an
  emoji, so a row of them is one trip to the picker instead of one trip each. It
  closes when you click away, press Escape, or send. On a phone it still closes
  on the first pick — there the picker covers the message you are writing.
- Picking an emoji that would push the message past its length limit now says
  the message is full, instead of the picker just disappearing.

## [1.8.0] — 2026-09-10

### Added

- **Emoji sent on their own are drawn large.** One to three emoji with nothing
  else in the message is somebody reacting rather than writing, and it now looks
  like it: the glyphs come up to the size every other messenger gives them and
  the coloured bubble behind them goes away, the same way it does for a sticker.
  A fourth emoji, or a single word beside them, is a message again and stays the
  size it was.

### Changed

- **The two panes line up on a desktop window.** The chat list, the conversation
  header and the room header each set their own height, so the rule under them
  landed in three different places and the seam between the panes read as
  crooked; the account row at the foot of the list sat above the message box
  beside it for the same reason. Both edges are now one height each.

## [1.7.1] — 2026-09-10

### Changed

- **The libraries the app is built on were brought up to date**, this time only
  within their current major versions, so nothing was meant to look or behave
  differently. What comes with them is other people's fixes: the notification
  SDK reads an Android payload back correctly, the QR scanner returns a result
  the system interrupted, and the component library corrects menus and toasts
  in right-to-left layouts. React itself moved a minor version.

## [1.7.0] — 2026-09-10

### Added

- **Conversations open from the phone instead of from the server.** The chat
  list and the messages in it are painted from what this device already holds,
  and the server's answer replaces them a moment later. Opening the app on a
  bad connection used to mean a spinner over an empty sidebar; with no
  connection at all it meant an empty app, over messages the phone had already
  decrypted and was still storing. Nothing extra is downloaded to make this
  work — it is the copy that was always there, finally being read.
- **The few conversations you are most likely to open are fetched while you are
  looking at the list**, so the first one you tap is already there. It is
  capped at a handful, only runs when the connection looks healthy, stops the
  moment you put the app away, and skips any conversation whose newest message
  the phone already has.

### Changed

- **Voice messages are recorded with two taps instead of a held finger.** Tap
  the microphone to start, tap the stop button to finish — the recording then
  waits in the composer with a player, so you can hear it back, scrub through
  it, throw it away or send it. Holding the button down was the old way, with a
  slide upwards to lock so your finger could leave; on a phone that asked you
  to keep a thumb perfectly still for as long as you were talking, and the way
  out of it was a gesture nothing on screen mentioned. Pausing mid-recording
  works at any point now, for the same reason: there is no longer a finger on
  the button that would have to press it.

- **A picture in a conversation no longer costs the whole picture.** Sending a
  photo or a video now also sends a much smaller preview, and that is what the
  thread draws — around a thirtieth of the pixels. The full file is fetched
  when you tap it open, save it or forward it, and not before. Scrolling
  through a conversation full of photographs used to download every one of them
  at full size to fill a thumbnail two hundred pixels wide, and a video bubble
  had to fetch the entire video to show you its first frame. Animations,
  stickers and voice notes are left alone, and anything sent before this update
  keeps working exactly as it did.
- **Everything the app asks for after waking up now queues instead of racing.**
  Coming back from sleep, or from a tunnel, used to fire every request in the
  app at the same instant — your profile, the chat list, the open conversation,
  its receipts, its reactions — which on a weak signal meant they all crawled
  and then all timed out together. They go through a few at a time now, so the
  conversation you are actually looking at arrives while the rest wait their
  turn.
- **A request that failed is retried at a slightly different moment each
  time**, rather than every failed request retrying in the same instant and
  rebuilding the pile that caused the failure. And a phone that knows it has no
  signal stops spending its retries proving it — they are saved for when there
  is something to reach.

## [1.6.0] — 2026-09-05

### Changed

- **The app has a proper sense of hierarchy now.** Every screen used to be
  written in one of two text sizes, which meant nothing on it could announce
  itself — the word "Chats" at the top of the list was set at exactly the size
  and weight of the name of the person in the first row underneath it, so the
  screen had no head and the eye had nowhere to start. Titles are now titles.
  Names, previews and timestamps in a conversation row are three visibly
  different things instead of three shades of the same grey.
- **The greys were doing too many jobs.** Secondary text was being drawn at
  twelve different strengths, three of them often inside a single row, picked
  by whoever wrote that line. There are four now, each one meaning something —
  what you are reading, what is emphasised, what supports it, what is merely
  present — and that is the difference between an app that looks restrained and
  one that looks washed out.
- **The logo's two-tone blue finally appears inside the app.** The mark is one
  disc cut on the diagonal and pulled apart, a lit half and a half in shadow,
  and until now you only ever saw it on the app icon and the sign-in screen —
  everywhere else the accent was a single flat colour. It now marks the
  conversation you have open, the button that starts a new one, the tab you are
  on, and your own avatar. Deliberately nowhere else: it is meant to be a
  signature, and a signature on every surface is wallpaper. Message bubbles in
  particular keep their flat fill.
- **Each theme carries its own version of that two-tone**, hand-picked rather
  than computed from its accent colour. Computing it would have quietly ruined
  the two packs it matters most to — Graphite has no accent hue to derive from,
  and Paper's would have come out muddy.
- **Rounded corners now follow the theme you chose.** Every card, field and
  message bubble used to be rounded by a fixed amount regardless, which meant
  Terminal's deliberately sharp corners and Sakura's deliberately soft ones only
  ever reached about a third of the app. They reach all of it now, so the packs
  read as more different from each other than they did.
- **The line under the chat header lost its drop shadow.** It was a black
  shadow, so on the two light themes it was a grey smudge, and it was the one
  piece of the app still contradicting the flat surface treatment everything
  else follows.

## [1.5.3] — 2026-09-05

### Changed

- **The libraries the app is built on were brought up to date, several of them
  by whole major versions.** Nothing was meant to look or behave differently,
  and most of the work went into keeping it that way: the pieces that quietly
  changed meaning between versions — how thick a ring around an avatar is, how
  strong the blur over a hidden recovery phrase is, whether buttons get a
  gradient — were each pinned back to what they already were. What it buys is a
  line that still receives security and bug fixes; the previous one had stopped.
- **The emoji picker no longer leans on an abandoned package.** It was a
  twenty-line wrapper, last touched in early 2023, and it was the only thing
  keeping the whole interface a major version behind. Those twenty lines now
  live in the app, and one long-standing quirk went with them: the picker used
  to keep whichever close-handler it was given when it first opened, so it
  could stop closing after the conversation around it re-rendered.

## [1.5.2] — 2026-09-05

### Fixed

- **Signing out of one account no longer discards another account's unsent
  messages.** Messages waiting to be sent are kept in one place shared by
  everybody signed in on the phone, and signing out emptied all of it rather
  than only the part belonging to whoever was leaving. A second account could
  lose a message it had written and never been told did not arrive. The same
  went for deleting an account.
- **Removing an account from this device now takes its kept photos and voice
  notes with it.** Pinning an attachment writes a decrypted copy into the app's
  private storage, and the record of which copies belong to which account lives
  inside that account. Removing an account erased the record first, which left
  the pictures on the phone with nothing able to name them, count them, or
  delete them — on a device that had just been told to forget the person they
  belonged to.
- **A message written with no signal is no longer given up on after half a
  minute.** Sending was retried five times on a doubling delay and then reported
  as failed, and a phone in a lift or a tunnel spent all five without any of
  them ever reaching a network. Attempts now count only the times a server
  actually refused the message; with no signal the queue waits, and sends as
  soon as there is one.
- **Deleting your account now also removes it from the account switcher.** The
  row stayed behind and only revealed the account was gone when somebody tapped
  it and was asked to sign in.

### Changed

- Dependencies moved to their latest compatible releases — Capacitor 8.5.1 and
  its plugins, Supabase 2.115, OneSignal 5.5.4, RevenueCat 13.5 — all of them
  patch and minor updates within the versions already in use. The recovery
  phrase's derivation is now pinned to written-down values in the test suite
  rather than only compared against itself, so an upgrade that quietly moved it
  fails the build instead of locking every existing account out of its own
  messages.

## [1.5.1] — 2026-08-22

### Fixed

- **The emoji and sticker picker stays open when the other person types or
  sends something.** The thread scrolls itself down to keep the newest message
  in view, and the picker was closing on any scroll anywhere on the screen —
  including one it had nothing to do with. It now closes only on a scroll that
  actually moves the button it hangs from, so the reaction picker still gets out
  of the way when the message it belongs to scrolls past.
- **Selecting text in a message you are editing now shows the highlight.** The
  selection colour was the same accent your own messages are painted with, so
  the highlight was drawn in the bubble's own colour, on the bubble — there, but
  impossible to see. It takes the bubble's text colour instead.

## [1.5.0] — 2026-08-20

### Added

- **Tap someone's picture in a chat header to see who they are.** Their photo,
  the name they chose, the name you gave them, whether you have verified them,
  and a new line they can write about themselves. The card is read-only apart
  from the nickname: verifying, the background and the disappearing-message
  timer already live in the ⋮ menu beside it, and a second door to each of them
  is a second thing to keep in step.
- **You can write a short line about yourself**, in Settings → Profile, shown to
  people you are connected to. It is stored unencrypted, like your display name
  and your photo; “What the server knows” lists it, which is where that belongs.
  Sealing it would mean a separate copy encrypted for every contact, re-made
  every time you edited a word — a great deal of machinery around a paragraph
  that sits beside a face the server can already see.

### Changed

- **The private nickname you give a contact is now encrypted before it is
  stored.** It was always hidden from the person it names — they are never told
  — but it sat in the database as ordinary text, so “only you can see this” was
  true of the app and not of the server. It is now sealed with the key on your
  phone, like your stickers and their names. Nicknames set before this update
  keep working and are re-encrypted the first time each device opens the app.
- **Names no longer carry an `@` in front of them.** The sigil suggested a
  handle you could look somebody up by, and there has been nothing to look
  anybody up in since the directory was removed — people are added by connect
  code or QR now.
- **“What the server knows” describes the whole database again.** Four tables
  behind group chats — reactions, read marks and the two notification tables —
  had never been described, so the screen was showing its own “this is out of
  date” warning. Six cards were also explaining the wrong table, having each
  picked up the note belonging to the one above it.
- **That screen now checks its own column lists against the live database.** It
  could already tell you about a table nobody had described; it could not tell
  you about a column, which is what its “server reads: …” lines actually claim.
  If those lists ever fall behind again, the screen says so in the app instead
  of quietly under-reporting what is stored about you.
- **Less small print.** Settings hints, the notes under fields and the new
  profile card had drifted into explaining how the server works, in places where
  the job was to help you decide something. They say the useful half now. The
  explanations have not gone anywhere: they are in the privacy policy and on
  “What the server knows”, which are written for somebody who came to read them.
- **Three things the server was keeping for nobody are gone.** A record of who
  redeemed whose connect code — written on every connection and read by
  nothing; spent connect codes, which now expire away with everything else; and
  a leftover search extension from before the server stopped holding message
  text, whose presence suggested it still could.

### Fixed

- **Opening a photo full-screen no longer puts the reaction menu on top of it.**
  A long press, or a double click on a computer, reached the message underneath
  the viewer — so reactions appeared in the middle of the picture, and a double
  tap started a reply to it. Nothing that happens inside the viewer reaches the
  conversation behind it now.
- **Exported data no longer carries a piece of the app's own source in it.** The
  explanatory note at the top of the file had been assembled wrongly and read
  `server.push_config.note` where the sentence should have been.

## [1.4.6] — 2026-08-20

### Fixed

- **The words under a photo, a video or a voice note can now be corrected.**
  A caption is an ordinary message body — sealed the same way, in the same two
  columns — but the message menu asked for a row with no attachment on it, so a
  typo under a picture could only be fixed by deleting the picture and sending
  it again. Editing one now opens the message with the attachment still on
  screen, so you are correcting a caption rather than describing something you
  can no longer see, and clearing the box takes the caption back and leaves the
  attachment standing on its own. A sticker sent by itself is still not
  editable: it draws with no bubble around it, so there is nothing for words to
  sit on.

## [1.4.5] — 2026-08-20

### Fixed

- **Declining a request by accident is no longer a dead end.** Declining also
  hides that person on this device, so anything they sent afterwards was
  swallowed silently — and adding them yourself answered "they already sent you
  a request, accept it from your pending list", which was a list they had been
  hidden from. Now: the decline says out loud that they were hidden and where
  to undo it, unhiding them in Settings puts their waiting request straight
  back in the list instead of needing a restart, and scanning or typing their
  code accepts the request they already sent and unhides them in the same
  gesture.
- **A pin, mute or unhide made on one screen now shows on the others at once.**
  The chat list, the room list and the settings pages each held their own copy
  of those flags, so a change made in one could sit unnoticed in another until
  the app was restarted.

## [1.4.4] — 2026-08-19

### Fixed

- **A pinned photo now really does outlive the pruning it was pinned against.**
  Pinning keeps a copy of an attachment on your phone so it survives the
  server's clean-up of old files, and half of that was working: the copy was
  kept, but once the person who sent it pruned their end, their message came
  back as "media removed" and the picture you had deliberately saved was
  unreachable behind it. The message is now rebuilt from what your phone kept —
  **including the caption it was sent with**, which the clean-up used to write
  over. Pins made before this update keep the picture; only captions saved from
  now on can be restored, because before this there was nothing holding them.
- **A pin no longer outlives the message.** A photo you pinned in a
  disappearing conversation goes when the timer takes the message, and one the
  sender deletes for everyone goes with the deletion. Pinning is a way around
  the storage limit, not around either of those.

## [1.4.3] — 2026-08-19

### Changed

- **"Typing" moved out of the header and into the conversation.** It used to
  take over the line that says whether the other person is online, so that line
  flickered between two states for as long as somebody was writing. It is now a
  bubble at the bottom of the thread, where the message being typed will
  actually appear, and the header goes back to saying one thing steadily. If you
  are already at the bottom of a conversation the view follows the bubble in, so
  it can't arrive under the fold.

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
