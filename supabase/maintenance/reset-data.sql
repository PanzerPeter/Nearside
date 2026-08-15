/*
  ===========================================================================
  Nearside — WIPE ALL USER DATA
  ===========================================================================

  This deletes every account and everything that hangs off one. It is not a
  migration, it is not in `migrations/apply-order.txt`, and `db:verify` does
  not read it — it changes no schema, only rows.

  There is no undo, and no backup is taken for you. The project this is aimed
  at has no point-in-time recovery on the free plan: what this removes is
  gone. Read the whole file before running any of it.

  It exists because a demo account accumulates state that a fresh install
  cannot see past — half-finished friendships, keys from a reinstall, sealed
  answers with no readable prompt — and starting from nothing is faster than
  reasoning about which of those is real.

  ---------------------------------------------------------------------------
  Order matters, and step 1 is not SQL
  ---------------------------------------------------------------------------

  1. Empty the three storage buckets FIRST — `avatars`, `chat-media` and
     `stickers` — with `empty-buckets.mjs` beside this file, or from the
     Dashboard (Storage → bucket → select all → Delete).

     This cannot be done in SQL, and trying is how you find out:

         ERROR: 42501: Direct deletion from storage tables is not allowed.
                Use the Storage API instead.

     That is `storage.protect_delete()`, and it is right to refuse. A row in
     `storage.objects` is the only record of where a file lives — delete the
     row and the bytes stay on S3 forever with nothing left that can name
     them. The API removes both.

     Note what the error costs if you ignore this ordering: the SQL editor
     runs a script as one transaction, so a DELETE that raises here takes the
     `auth.users` delete below down with it and nothing at all happens. The
     wipe reports failure rather than half-completing, which is the one good
     thing about hitting it.

  2. Run section A below. One DELETE does the whole database.

  3. Run section B to confirm nothing is left.

  4. On every device that was signed in, sign out from inside the app —
     Settings → sign out. The server is not the only copy: each install holds
     a decrypted SQLite mirror, an unsent-message outbox, pinned attachment
     bytes, the account roster and a seed in the Keystore, and `App.signOut`
     is what clears all of them together. An install left signed in after this
     shows a conversation list of accounts that no longer exist and fails its
     next token refresh instead.

     A reinstall (or Android's "clear app data") does the same thing and is
     the surer option if the app will not open far enough to reach settings.

  5. Sign up again. Nothing else needs doing: the buckets, the policies, the
     triggers and the cron jobs all survive, because none of them is data.
*/

-- ===========================================================================
-- A. The wipe
-- ===========================================================================

-- Every table in `public` reaches `auth.users` by a chain of
-- `REFERENCES ... ON DELETE CASCADE` — through `profiles` for the messaging
-- tables, directly for `connect_tokens`, `rooms` and the three room tables.
-- So this one statement empties `profiles`, `friendships`, `connect_tokens`,
-- `messages`, `message_reactions`, `message_receipts`, `sealed_answers`,
-- `stickers`, `chat_backgrounds`, `friend_nicknames`, `rooms`,
-- `room_participants`, `room_keys`, `room_messages`, `conversation_timers`,
-- `message_pushes` and `theme_grants`.
--
-- Listing those tables here instead would be the same delete with more ways
-- to get it wrong, and would go stale the first time a table is added.
DELETE FROM auth.users;

-- `push_config` is deliberately NOT touched. It holds the push function's URL
-- and trigger secret — configuration, not anyone's data — and the trigger
-- silently stops firing if the row goes. It has no foreign key to a user, so
-- the cascade above leaves it alone; this comment is here so nobody adds it.

-- There is no DELETE for `storage.objects` here, and adding one breaks this
-- whole script: `storage.protect_delete()` raises on it, and the raise rolls
-- back the statement above with it. Step 1 is the storage step.

-- ===========================================================================
-- B. Proof it worked
-- ===========================================================================
--
-- Every count must be 0. A non-zero `public` row here means a table has a
-- foreign key that does not cascade, which is a schema bug rather than a
-- leftover — the app assumes deleting an account removes its data, and
-- `delete-account` depends on the same chain this does.
--
-- `storage.objects` is the exception, and it is a plain SELECT: it counts
-- what step 1 left behind, so a skipped or half-finished bucket wipe shows up
-- here instead of as bytes billed forever to nobody.

SELECT 'auth.users'            AS relation, count(*) FROM auth.users
UNION ALL SELECT 'profiles',            count(*) FROM public.profiles
UNION ALL SELECT 'friendships',         count(*) FROM public.friendships
UNION ALL SELECT 'connect_tokens',      count(*) FROM public.connect_tokens
UNION ALL SELECT 'messages',            count(*) FROM public.messages
UNION ALL SELECT 'message_reactions',   count(*) FROM public.message_reactions
UNION ALL SELECT 'message_receipts',    count(*) FROM public.message_receipts
UNION ALL SELECT 'sealed_answers',      count(*) FROM public.sealed_answers
UNION ALL SELECT 'stickers',            count(*) FROM public.stickers
UNION ALL SELECT 'chat_backgrounds',    count(*) FROM public.chat_backgrounds
UNION ALL SELECT 'friend_nicknames',    count(*) FROM public.friend_nicknames
UNION ALL SELECT 'rooms',               count(*) FROM public.rooms
UNION ALL SELECT 'room_participants',   count(*) FROM public.room_participants
UNION ALL SELECT 'room_keys',           count(*) FROM public.room_keys
UNION ALL SELECT 'room_messages',       count(*) FROM public.room_messages
UNION ALL SELECT 'conversation_timers', count(*) FROM public.conversation_timers
UNION ALL SELECT 'message_pushes',      count(*) FROM public.message_pushes
UNION ALL SELECT 'theme_grants',        count(*) FROM public.theme_grants
UNION ALL SELECT 'storage.objects',     count(*) FROM storage.objects
  WHERE bucket_id IN ('avatars', 'chat-media', 'stickers')
ORDER BY 1;
