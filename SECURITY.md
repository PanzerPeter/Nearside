# Security

Nearside is an end-to-end encrypted messenger, so a security bug here is the
product failing rather than a feature misbehaving. This file says what the app
promises, what it does not, and how to report a problem.

## Reporting a vulnerability

Open a **private security advisory** on this repository
(`Security` → `Report a vulnerability`), or write to **Hi.Nearside@protonmail.com**.

Please do not open a public issue for anything that lets someone read a message,
impersonate a sender, or reach a key.

Include what you need to demonstrate it: the version or commit, the platform, and
the steps. There is no bug bounty — this is a solo project — but every report is
answered, and anything valid is credited in [CHANGELOG.md](CHANGELOG.md) unless
you would rather not be.

Expect a first reply within a week.

## What is in scope

Anything that breaks one of these:

- A message body, an attachment, or a call's media is readable by the server, by
  a relay, or by anyone but the intended recipients.
- A recovery seed or a derived key leaves the device — into Postgres, a log, a
  crash report, a notification payload, or an analytics call.
- A message is attributed to someone who did not send it (this is what the
  Ed25519 signature in a room exists to prevent).
- A row is readable or writable by an account that RLS should have excluded.
- The app lock, `FLAG_SECURE`, or per-account isolation on a shared phone can be
  bypassed — for example one account inheriting another's key material or cache.
- A key change is accepted silently rather than blocking the composer.

## What is out of scope

Not because it does not matter, but because the app already says so on its own
transparency screen and in [README.md](README.md#where-the-protection-stops):

- **Metadata.** The server knows who talks to whom and when, plus
  `display_name` and `last_seen_at`. This is not encrypted and is not claimed to
  be.
- **A compromised device.** The seed lives in the Android Keystore or the iOS
  Keychain, but a rooted or jailbroken phone can reach what runs on it.
- **A recipient keeping a copy.** Screenshots, a camera pointed at a screen, and
  messages held by someone removed from a room afterwards. Disappearing messages
  are a convenience, not an enforcement.
- **IP exposure to the person you are calling.** WebRTC is peer-to-peer by
  design; the privacy policy says so in those words.
- **A TURN relay seeing that two addresses exchanged packets.** It forwards SRTP
  it cannot read, and credentials are minted per call with a short life.
- Denial of service against Supabase, rate-limit brute forcing, and reports
  produced only by an automated scanner with no working path to impact.

## The design in one screen

- **Keys.** Twelve words → seed → three keys via fixed context labels
  (`BOX_CONTEXT`, `SIGN_CONTEXT`, `VAULT_CONTEXT`) in `src/lib/crypto/keys.ts`.
  The seed is stored per account, never device-wide, because a device-wide slot
  let a second account on the same phone inherit the first one's private key.
  Changing a context label invalidates every existing user's keys, so those
  constants are frozen.
- **One seal boundary.** `src/lib/sealed-body.ts` is the only place a body is
  sealed or opened. There is no plaintext fallback: sealing throws when a peer
  has published no key rather than degrading, because a silent fallback is
  invisible to the sender.
- **The server holds no bodies.** Migration `0023` dropped `messages.content`
  and the server-side search that read it. Reads return rows still sealed
  (`src/lib/message-queries.ts`); opening happens at the component boundary.
- **Calls.** Media is peer-to-peer with keys from the DTLS handshake. Signalling
  is sealed `crypto_box` over a Realtime broadcast topic — SDP *and* ICE
  candidates, because a candidate carries the device's LAN address and public
  IP — and broadcast persists nothing, so there is no `calls` table by
  construction.
- **Notifications** carry a sender and never content. Not as a policy: after
  `0023` the push function has no body it could leak.
- **Sealed exchange.** A question whose two answers are released only once both
  exist. Fair exchange between parties who distrust each other is impossible
  without a referee, so there is one — the RLS policy on `sealed_answers`
  (`schema.sql` section 5c) — and it holds two ciphertexts it cannot open. The
  withholding is not enforced anywhere in the client, deliberately: this
  repository is public, and a check that lives in the app is a check anyone can
  delete.

  Its limit, stated rather than implied away: you can answer with nonsense to
  force the reveal. Nothing prevents that. What it costs is that the nonsense is
  immutable — there is no UPDATE policy and no UPDATE grant — and stays in the
  thread under your name. A compromised server could also release your answer
  early, which would let the other side read before writing; it could not let
  them change what they wrote, and it still cannot read either answer.

- **"In this conversation"** extracts dates and links from the decrypted copy in
  the device's own SQLite mirror (`src/lib/localdb.ts`, one file per account).
  No network call is made to build it and nothing about it is uploaded — there
  is nothing to upload it to, since the server holds no bodies. It is a second
  reader of plaintext already at rest on the device, so it inherits exactly the
  exposure that mirror already has, and nothing more.

Two tests are load-bearing and should be treated as part of the product's
claims, not as coverage: `src/lib/no-plaintext.test.ts` (no body ever reaches an
insert payload) and `src/lib/no-ads.test.ts` (no advertising SDK in
`package.json` or the Gradle build).

## Cryptography

libsodium (`libsodium-wrappers`) throughout, standard constructions only:
`crypto_box` (X25519 + XSalsa20-Poly1305) for peer messages and call signals,
`crypto_secretbox` for the self-chat vault and for room and file keys,
Ed25519 for room-message signatures, and PBKDF2-HMAC-SHA256 at 600k iterations
for the app-lock verifier. Nonces are random per seal. No primitive here is
home-made, and a report that one is being used incorrectly is exactly the kind
this file is asking for.

## Supported versions

Only the current `main` and the most recent build from it. There is no backport
branch.
