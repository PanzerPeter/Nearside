# Design

Why Nearside is built the way it is. [README.md](README.md) says what it does,
[SECURITY.md](SECURITY.md) says what it promises, [docs/APPEARANCE.md](docs/APPEARANCE.md)
covers themes, motion and elevation, and [docs/BUILDING.md](docs/BUILDING.md)
covers the native builds. This file is the reasoning underneath, in the order a
reader new to the codebase would want it.

Every decision below was made under one constraint: **the server must not be
able to read anything, and the app must not be able to pretend otherwise.**
Where a feature could not survive that, the feature changed.

---

## 1. Key derivation is a chain, and each link is deliberate

```
12 words → seed → Keystore/Keychain slot, per account → three keys
```

`src/lib/crypto/mnemonic.ts` produces the words, `src/lib/keystore.ts` stores the
seed under `nearside.identity.seed.<userId>`, and `src/lib/crypto/keys.ts`
derives a box key, a signing key and a vault key from it through fixed context
labels.

- **Per account, not per device.** The first version used a device-wide slot. A
  second account signing in on the same phone inherited the first account's
  private key. The slot has been keyed by user id ever since, and every
  per-account cache added since has had to be torn down in `App.signOut` for the
  same reason.
- **The context labels are frozen.** `BOX_CONTEXT`, `SIGN_CONTEXT` and
  `VAULT_CONTEXT` are inputs to the derivation. Changing one invalidates every
  existing user's keys, and there is no reset path — losing the twelve words
  loses the history. This is stated in the app before the phrase is shown, not
  after.
- **Three keys, not one.** Separating peer messages, signatures and the private
  vault means a bug in one path cannot open another.

## 2. One seal boundary

`src/lib/sealed-body.ts` is the only module that seals or opens a message body:
`crypto_secretbox` under the vault key for the self-chat, `crypto_box` to the
peer's published key for 1:1, and a per-room symmetric key plus an Ed25519
signature for rooms.

The signature exists because every room member holds the room key, so
decryption proves membership and not authorship — it is **verified before
decryption**, and a message that fails renders as a warning rather than being
hidden. A dropped message is an attack the user never learns about; a warning is
one they can act on.

There is deliberately **no plaintext fallback**. `sealBody` throws when a peer
has no published key. Degrading gracefully would be invisible to the sender and
would quietly falsify the one claim the product is built on.

Call signalling is sealed separately (`src/lib/call/signaling.ts`) rather than
being pushed through this module: that boundary branches on the self-chat and
writes opened text into the local mirror, neither of which is right for a
payload that must never be persisted anywhere.

## 3. The server holding no bodies is a product decision with costs

Migration `0023` dropped `messages.content` and `search_messages()`. Everything
that used to read a body server-side had to move or die:

| Was | Is now |
| --- | --- |
| SQL full-text search | search over `src/lib/localdb.ts`, a SQLite mirror of what *this device* decrypted |
| Conversation previews from the last row | previews from the same local mirror |
| Push notifications with a message preview | sender only — the push function has no body it could leak |

The costs are real and are not bugs: a conversation is unsearchable on a device
that never loaded it, and there is one database file per account. The app says
so on its transparency screen rather than hiding it.

Reads stay honest by construction — `src/lib/message-queries.ts` holds every
`messages` query and returns rows **still sealed**. Opening happens at the
component boundary, the only layer holding both an identity and a peer key, so
"where could a body leak from?" has one answer instead of thirty.

## 4. No directory, and connection carries trust

`search_profiles()` is gone. Display names collide freely and nobody can be
found by one, so the failure mode of a small social app — strangers arriving
because they guessed a handle — cannot happen.

You connect by scanning a QR code or reading an eight-character code aloud.
Codes are single-use and expire in ten minutes. A **scan also verifies the
contact**, because the public key travelled inside the QR: the common case
produces a verified contact with no extra step, which is the only way
verification ever gets used.

When a contact's key changes, the composer blocks. The app does not guess
whether that was a reinstall or an interception, because it cannot, and guessing
in the user's favour is how key-change warnings become noise.

## 5. Calls: the hard part is answering, not talking

`src/hooks/useCall.tsx` owns the state machine, the signalling hub, the peer
connection and the native side for the whole app, because a call outlives the
conversation that started it.

The `CallSession` deliberately sits **outside** the generation effect described
in §7: its media is peer-to-peer and survives a Supabase socket that does not,
so rebuilding it on a reconnect would drop every call the moment a screen came
back on. The signalling hub, which is Supabase's, *is* keyed on generation.

The expensive path is a ring on a locked phone whose app the system has killed,
and each of these exists to shorten it:

- The caller's topic is joined **from the notification**, not from the friend
  list — until the friend query lands the hub holds no topics at all, so the
  offer would be broadcast to an empty room.
- The hub adds and removes topics rather than being rebuilt, because the friend
  list arrives *during* the answer on this path.
- The answering side sends `ready` when its topic goes live and the caller
  re-offers at once. Broadcast has no replay, so without it the answer waits out
  whatever is left of the offer-repeat interval.
- TURN credentials and the microphone are opened during that wait
  (`src/lib/call/warmup.ts`). **Capture is only ever primed after the user has
  answered** — a microphone opened on a ring nobody accepted is an app listening
  to a room that did not agree to it.
- Answering from the lock screen goes straight to "Connecting…": no Answer
  button, no ringtone, and no ring notification for a call already picked up.

`src/lib/call/state.ts` and `routing.ts` are pure and hold every interleaving
that matters, so the parts worth testing are reachable from a node test suite.
New call logic belongs there rather than in the provider.

## 6. Disappearing messages belong to the conversation

The timer is keyed by a sorted pair of user ids, not by one side's preference. A
per-user setting would let one party keep a copy the other believed was gone,
which is a privacy feature that lies.

Enforcement is server-side: a trigger stamps `expires_at` and `pg_cron` deletes.
`src/lib/disappearing.ts` is presentation plus the local sweep that keeps the
mirror in step. Screenshots remain possible and the app says so directly beside
the setting.

## 7. One `generation` counter instead of per-hook reconnect logic

`src/lib/connection.ts` detects wake from three signals — visibility/pageshow,
`online`, and a wall-clock jump between watchdog ticks, the only one that fires
on a woken desktop — then refreshes the token, kicks the socket, and bumps a
counter. Every realtime subscriber keys its channel effect on that number, so
one bump rebuilds all subscriptions and re-runs the fetches beside them.

Channels report health back, and when realtime is believed down the thread polls
and a banner says so. A frozen conversation that looks fine is worse than a
degraded one that admits it.

`src/lib/supabase.ts` wraps `fetch` with a timeout and retries **reads only**: a
retried POST would double-insert a message. The outbox
(`src/lib/outbox.ts`) covers the other direction — unsent messages persist to
IndexedDB with client-generated uuids, so a retry after a lost response collides
on the primary key instead of writing a second copy.

## 8. Composition: logic out of components, so it can be tested

There is no DOM test setup, on purpose. `src/lib/**` is pure and covered; the
components are thin. `ChatRoom` is a shell, `useChatThread` is the hub
(pagination, realtime, catch-up, search jumps), and media, editing, receipts,
scrolling and trust each hang off their own hook. Anything worth asserting gets
pushed down into `lib/` rather than tested through a rendered tree.

## 9. Two mechanisms for the system bars, one set of variables

targetSdk 36 makes edge-to-edge mandatory. Capacitor's `SystemBars` handles it
two different ways depending on the WebView version — real
`env(safe-area-inset-*)` on 140+, and padding the WebView's parent below that,
where the injected variables hold zero. `index.css` folds both into
`--safe-top`/`--safe-bottom` with `max()`, and the rule is to **use those,
never `env()` directly**, or a fix works on one half of the fleet.

Bar icon contrast comes from the active theme rather than the phone's dark-mode
setting, which is Capacitor's default and is wrong whenever a purchased pack
disagrees with the OS.

## 10. Money, and what it is not allowed to buy

Revenue is cosmetic theme packs and donation tiers, both non-consumable, through
RevenueCat. Nothing behind a paywall touches encryption, message limits, or
pinning, and there is no advertising SDK — `src/lib/no-ads.test.ts` fails the
build if one appears in `package.json` or the Gradle build. An encrypted
messenger funded by an ad network is not an encrypted messenger.

## 11. Two paths to the schema, kept in step by a container

`supabase/schema.sql` is the current shape of the database in one file and is
the fastest answer to "what does the server hold?". `supabase/migrations/*.sql`
is the history, applied in the order given by `apply-order.txt` — which is not
numeric order, because later migrations supersede parts of earlier ones.

A schema change is therefore two edits, and `npm run db:verify` builds a
database from each path in a throwaway Postgres container and diffs the
catalogs — tables, constraints, policies, function bodies, grants, buckets — so
doing one without the other fails locally rather than in production, which has
no undo.

## 12. Conventions that follow from all of this

- **Comments explain *why*, and usually name the failure the code prevents.** A
  comment restating the line below it does not belong. Most of this document
  exists in the source already, next to the code it constrains.
- **Privacy claims in the UI are built from live queries and real schema**, not
  from hard-coded copy, so the transparency screen cannot drift into marketing.
- **The native builds are the product.** The browser build is a development
  convenience, and anything resting on a native plugin degrades to a no-op there
  rather than pretending to work.
