# Migrations

Applied **by hand in the Supabase SQL editor**, one file at a time, in the
order given by [`apply-order.txt`](apply-order.txt). There is no
`supabase db push` here and no migration history table this repository owns.

Three things to know before running anything:

1. **Apply order is not numeric order.** `0022b` was authored beside `0022` but
   could not be applied until the connect-code flow that replaces the directory
   worked on a device, so it lands after `0025`. The number records authorship;
   `apply-order.txt` records application.
2. **Later files supersede parts of earlier ones.** Re-running an early file
   can revert a later one — `0001` recreates the pre-invite `handle_new_user`,
   `0014` recreates the push trigger without `0017`'s self-chat guard. Every
   file that is dangerous to re-run says so in its header banner. Read it.
3. **There is no undo.** These run against a live project with real accounts.
   `npm run db:verify` replays the whole folder into a throwaway Postgres
   container; dry-run a new file there before pasting it into the SQL editor.

To add one: write the file, add it to `apply-order.txt`, fold the same change
into [`../schema.sql`](../schema.sql), then run `npm run db:verify`.

## What is live

Everything below is applied to the project named in `.env`, except where the
last column says otherwise. `SETUP.md` is authoritative on that project's
current state; this table is about what each file *does*.

| # | File | Effect |
|---|------|--------|
| 1 | `0001_init.sql` | `profiles`, `friendships`, `messages`, the signup trigger, realtime on messages |
| 2 | `0002_push_subscriptions.sql` | Web Push endpoints — **table dropped by `0028`** |
| 3 | `0003_reactions_replies.sql` | `message_reactions`, `messages.reply_to_id` |
| 4 | `0004_friendships_realtime.sql` | `REPLICA IDENTITY FULL` + publication for friendships |
| 5 | `0005_messages_immutable_participants.sql` | Trigger freezing `user_id` / `receiver_id` — closes an unsolicited-DM vector RLS cannot |
| 6 | `0006_message_receipts.sql` | `message_receipts`, monotonic watermarks, `unread_counts()` |
| 7 | `0007_conversation_list.sql` | First `conversation_list()` — **superseded four times; do not re-run** |
| 8 | `0008_invite_codes.sql` | Invite-gated signup, narrowed profiles SELECT, `search_profiles()` |
| 9 | `0009_rate_limits.sql` | Message and friend-request flood guards |
| 10 | `0010_message_search.sql` | pg_trgm + `search_messages()` — **both dropped by `0023`** |
| 11 | `0011_last_seen.sql` | `profiles.last_seen_at`; rebuilds `conversation_list()` |
| 12 | `0012_chat_backgrounds.sql` | Per-conversation background — **table replaced by `0013`** |
| 13 | `0013_chat_backgrounds_per_user.sql` | Backgrounds become per-user; carries the old rows over |
| 14 | `0014_server_side_push.sql` | `message_pushes`, `push_config`, pg_net trigger. Inert until `push_config` has a row |
| 15 | `0015_voice_messages.sql` | `audio` media type + `media_duration_ms` |
| 16 | `0016_friend_nicknames.sql` | Private per-user nicknames |
| 17 | `0017_self_chat.sql` | The conversation with yourself, across five gates at once |
| 18 | `0018_forwarded_messages.sql` | `messages.forwarded`, frozen alongside the participants |
| 19 | `0019_open_signup.sql` | Drops the invite gate and `invite_codes` |
| 20 | `0019a_revoke_trigger_function_execute.sql` | Revokes client EXECUTE on two trigger functions |
| 21 | `0020_identity_keys.sql` | `profiles.public_key` / `signing_key` / `key_updated_at` |
| 22 | `0021_encrypted_bodies.sql` | `messages.ciphertext` / `nonce`; widens `has_body` |
| 23 | `0022_display_name.sql` | `username` → `display_name`; UNIQUE and format constraints dropped |
| 24 | `0023_server_stops_reading_bodies.sql` | **Drops `messages.content` and `search_messages()`.** Irreversible |
| 25 | `0024_encrypted_media.sql` | `media_key_ciphertext` / `media_key_nonce` |
| 26 | `0025_sealed_media_mime.sql` | `chat-media` accepts `application/octet-stream` |
| 27 | `0022b_no_directory.sql` | **Drops `search_profiles()`**; adds `connect_tokens` and the mint/redeem RPCs |
| 28 | `0026_rooms.sql` | Group rooms: sealed room keys, signed messages, `rooms_for_me()` |
| 29 | `0027_transparency.sql` | `public_table_names()`, so the transparency screen can catch itself going stale |
| 30 | `0028_drop_web_push.sql` | Drops `push_subscriptions` |
| 31 | `0029_disappearing.sql` | `conversation_timers`, trigger-stamped `expires_at`, `pg_cron` sweep |
| 32 | `0030_theme_grants.sql` | `theme_grants` + grant/revoke helpers, readable by its owner and writable by nobody |
| 33 | `0031_grant_hygiene.sql` | Re-revokes `conversation_list()` from `anon`; renames `chat_backgrounds_pkey1` |

## The two files that do not follow the numbering

`0019a` is lexically between `0019` and `0020` on purpose — `0020_identity_keys`
was already written when the revoke was found, and renumbering a file someone
may have already applied is worse than an odd name.

`0022b` is the second half of a migration whose first half (`0022`) was applied
early, while the database still held no accounts to migrate. Its own header
explains why it had to wait.
