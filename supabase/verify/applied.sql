/*
  Nearside — "did every migration actually land?", read-only, one statement.

  Paste the whole file into the Supabase SQL editor and run it. It writes
  nothing, creates nothing and locks nothing: every line below is a catalog
  SELECT. One row per file in migrations/apply-order.txt, plus a few things
  that are required but are not migrations, and a SUMMARY row at the top.

  Why this exists beside `npm run db:audit`. The audit is the thorough answer —
  it diffs the live catalog against schema.sql, fact by fact — and it needs
  Docker, psql and the database password. This needs a browser tab. It is the
  cheap triage: which *file* is missing, not which fact.

  What a row means:
    OK        the artifact that file leaves behind is present
    MISSING   it is not — that file most likely never ran (see caveat)
    n/a       a later migration removed everything that file created, so its
              application cannot be observed any more; the row names the one
              that superseded it

  The last four rows are not migrations. They are the steps applied by hand
  beside them — the buckets, pg_cron, pg_net — which nothing complains about
  when they were skipped, and a standing check that no table in `public` ended
  up with RLS switched off.

  Caveat worth reading once. A marker is evidence, not proof: each row checks
  one or two things a migration leaves behind, so a file applied *partly* —
  the failure mode 0049 and 0050 were written for — can still read OK. A green
  board here means "nothing is obviously missing"; `npm run db:audit` is what
  says the database is the shape this repo describes.
*/

WITH
tbls AS (
  SELECT c.relname::text AS name, c.relreplident::text AS ri
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
),
cols AS (
  SELECT c.relname::text AS tbl, a.attname::text AS col
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped
),
fns AS (
  SELECT p.proname::text AS name, p.prosrc AS src, p.prosecdef AS definer, p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
),
pols AS (
  SELECT policyname::text AS name, tablename::text AS tbl, cmd::text AS cmd,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') AS body
    FROM pg_policies WHERE schemaname IN ('public', 'storage')
),
trgs AS (SELECT tgname::text AS name FROM pg_trigger WHERE NOT tgisinternal),
idxs AS (
  SELECT c.relname::text AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'i'
),
cons AS (
  SELECT con.conname::text AS name
    FROM pg_constraint con
    JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE n.nspname = 'public'
),
pubs AS (
  SELECT tablename::text AS name FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
),
bkts AS (SELECT id::text AS name, allowed_mime_types FROM storage.buckets),
checks(ord, migration, proves, ok) AS (VALUES
  (1,  '0001_init',                  'profiles + friendships + messages, on_auth_user_created',
       (SELECT count(*) = 3 FROM tbls WHERE name IN ('profiles','friendships','messages'))
        AND EXISTS (SELECT 1 FROM trgs WHERE name = 'on_auth_user_created')),
  (2,  '0002_push_subscriptions',    'superseded by 0028 (table dropped)', NULL),
  (3,  '0003_reactions_replies',     'message_reactions + messages.reply_to_id',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'message_reactions')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'reply_to_id')),
  (4,  '0004_friendships_realtime',  'friendships published, REPLICA IDENTITY FULL',
       EXISTS (SELECT 1 FROM pubs WHERE name = 'friendships')
        AND EXISTS (SELECT 1 FROM tbls WHERE name = 'friendships' AND ri = 'f')),
  (5,  '0005_messages_immutable_participants', 'messages_prevent_reassign trigger',
       EXISTS (SELECT 1 FROM trgs WHERE name = 'messages_prevent_reassign')),
  (6,  '0006_message_receipts',      'message_receipts + unread_counts()',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'message_receipts')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'unread_counts')),
  (7,  '0007_conversation_list',     'conversation_list()',
       EXISTS (SELECT 1 FROM fns WHERE name = 'conversation_list')),
  (8,  '0008_invite_codes',          'profiles_select_connected (the table itself went in 0019)',
       EXISTS (SELECT 1 FROM pols WHERE name = 'profiles_select_connected')),
  (9,  '0009_rate_limits',           'enforce_message_rate() + messages_rate_limit',
       EXISTS (SELECT 1 FROM fns WHERE name = 'enforce_message_rate')
        AND EXISTS (SELECT 1 FROM trgs WHERE name = 'messages_rate_limit')),
  (10, '0010_message_search',        'superseded by 0023 (search_messages dropped with the bodies)', NULL),
  (11, '0011_last_seen',             'profiles.last_seen_at',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'last_seen_at')),
  (12, '0012_chat_backgrounds',      'superseded by 0013 (pair table replaced)', NULL),
  (13, '0013_chat_backgrounds_per_user', 'chat_backgrounds.owner_id + peer_id',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'chat_backgrounds' AND col = 'owner_id')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'chat_backgrounds' AND col = 'peer_id')),
  (14, '0014_server_side_push',      'push_config + message_pushes + notify_push_on_message()',
       (SELECT count(*) = 2 FROM tbls WHERE name IN ('push_config','message_pushes'))
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'notify_push_on_message')),
  (15, '0015_voice_messages',        'messages.media_duration_ms',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'media_duration_ms')),
  (16, '0016_friend_nicknames',      'friend_nicknames',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'friend_nicknames')),
  (17, '0017_self_chat',             'messages_insert_sender admits receiver_id = user_id',
       EXISTS (SELECT 1 FROM pols WHERE name = 'messages_insert_sender'
                 AND body LIKE '%receiver_id = user_id%')),
  (18, '0018_forwarded_messages',    'messages.forwarded',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'forwarded')),
  (19, '0019_open_signup',           'invite_codes gone, handle_new_user reads no code',
       NOT EXISTS (SELECT 1 FROM tbls WHERE name = 'invite_codes')
        AND NOT EXISTS (SELECT 1 FROM fns WHERE name = 'handle_new_user' AND src LIKE '%invite%')),
  (20, '0019a_revoke_trigger_function_execute', 'clients cannot EXECUTE the two trigger functions',
       NOT EXISTS (SELECT 1 FROM fns
                    WHERE name IN ('notify_push_on_message','set_updated_at')
                      AND (has_function_privilege('anon', oid, 'EXECUTE')
                        OR has_function_privilege('authenticated', oid, 'EXECUTE')))),
  (21, '0020_identity_keys',         'profiles.public_key + signing_key',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'public_key')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'signing_key')),
  (22, '0021_encrypted_bodies',      'messages.ciphertext + nonce',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'ciphertext')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'nonce')),
  (23, '0022_display_name',          'profiles.display_name, username gone',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'display_name')
        AND NOT EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'username')),
  (24, '0023_server_stops_reading_bodies', 'messages.content gone, search_messages() gone',
       NOT EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'content')
        AND NOT EXISTS (SELECT 1 FROM fns WHERE name = 'search_messages')),
  (25, '0024_encrypted_media',       'messages.media_key_ciphertext',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'media_key_ciphertext')),
  (26, '0025_sealed_media_mime',     'chat-media accepts application/octet-stream',
       EXISTS (SELECT 1 FROM bkts WHERE name = 'chat-media'
                 AND 'application/octet-stream' = ANY(allowed_mime_types))),
  (27, '0022b_no_directory',         'connect_tokens + mint_connect_code(), search_profiles() gone',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'connect_tokens')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'mint_connect_code')
        AND NOT EXISTS (SELECT 1 FROM fns WHERE name = 'search_profiles')),
  (28, '0026_rooms',                 'the four room tables + is_room_member()',
       (SELECT count(*) = 4 FROM tbls
         WHERE name IN ('rooms','room_participants','room_keys','room_messages'))
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'is_room_member')),
  (29, '0027_transparency',          'public_table_names()',
       EXISTS (SELECT 1 FROM fns WHERE name = 'public_table_names')),
  (30, '0028_drop_web_push',         'push_subscriptions gone',
       NOT EXISTS (SELECT 1 FROM tbls WHERE name = 'push_subscriptions')),
  (31, '0029_disappearing',          'conversation_timers + messages.expires_at + expire_messages()',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'conversation_timers')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'expires_at')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'expire_messages')
        AND EXISTS (SELECT 1 FROM trgs WHERE name = 'messages_stamp_expiry')),
  (32, '0030_theme_grants',          'theme_grants + all_theme_packs()',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'theme_grants')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'all_theme_packs')),
  (33, '0031_grant_hygiene',         'anon cannot EXECUTE conversation_list, pkey renamed',
       NOT EXISTS (SELECT 1 FROM fns WHERE name = 'conversation_list'
                     AND has_function_privilege('anon', oid, 'EXECUTE'))
        AND NOT EXISTS (SELECT 1 FROM cons WHERE name = 'chat_backgrounds_pkey1')),
  (34, '0032_sealed_exchange',       'sealed_answers + messages.sealed_prompt, has_answered() definer, no UPDATE policy',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'sealed_answers')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'sealed_prompt')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'has_answered' AND definer)
        AND NOT EXISTS (SELECT 1 FROM pols WHERE tbl = 'sealed_answers' AND cmd = 'UPDATE')),
  (35, '0033_stickers',              'stickers table + stickers bucket',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'stickers')
        AND EXISTS (SELECT 1 FROM bkts WHERE name = 'stickers')),
  (36, '0034_write_guards',          'messages_body_guard + friendships_unique_pair',
       EXISTS (SELECT 1 FROM trgs WHERE name = 'messages_body_guard')
        AND EXISTS (SELECT 1 FROM idxs WHERE name = 'friendships_unique_pair')
        AND EXISTS (SELECT 1 FROM trgs WHERE name = 'friendships_prevent_reassign')),
  (37, '0035_push_alerts',           'push_alerts',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'push_alerts')),
  (38, '0036_room_parity',           'room_receipts + room_message_reactions + rooms.avatar_path',
       (SELECT count(*) = 2 FROM tbls WHERE name IN ('room_receipts','room_message_reactions'))
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'rooms' AND col = 'avatar_path')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'room_messages' AND col = 'media_path')),
  (39, '0037_room_push',             'room_message_pushes + notify_push_on_room_message()',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'room_message_pushes')
        AND EXISTS (SELECT 1 FROM tbls WHERE name = 'room_push_alerts')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'notify_push_on_room_message')),
  (40, '0038_alert_ladder',          'streak on both alert tables',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'push_alerts' AND col = 'streak')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'room_push_alerts' AND col = 'streak')),
  (41, '0039_sealed_backgrounds',    'chat_backgrounds.key_ciphertext + key_nonce',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'chat_backgrounds' AND col = 'key_ciphertext')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'chat_backgrounds' AND col = 'key_nonce')),
  (42, '0040_profile_bio',           'profiles.bio',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'profiles' AND col = 'bio')),
  (43, '0041_sealed_nicknames',      'friend_nicknames.nickname_ciphertext',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'friend_nicknames' AND col = 'nickname_ciphertext')),
  (44, '0042_token_hygiene',         'connect_tokens.used_by gone',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'connect_tokens')
        AND NOT EXISTS (SELECT 1 FROM cols WHERE tbl = 'connect_tokens' AND col = 'used_by')),
  (45, '0043_table_columns',         'public_table_columns()',
       EXISTS (SELECT 1 FROM fns WHERE name = 'public_table_columns')),
  (46, '0044_media_thumbnails',      'media_thumb_path on both message tables',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'messages' AND col = 'media_thumb_path')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'room_messages' AND col = 'media_thumb_path')),
  (47, '0045_receipt_privacy',       'receipt_prefs + shares_read()',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'receipt_prefs')
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'shares_read')),
  (48, '0046_room_forwarded',        'room_messages.forwarded',
       EXISTS (SELECT 1 FROM cols WHERE tbl = 'room_messages' AND col = 'forwarded')),
  (49, '0047_room_backgrounds',      'room_backgrounds + rooms.ttl_set_at',
       EXISTS (SELECT 1 FROM tbls WHERE name = 'room_backgrounds')
        AND EXISTS (SELECT 1 FROM cols WHERE tbl = 'rooms' AND col = 'ttl_set_at')),
  (50, '0048_pinned_messages',       'conversation_pins + room_pins + set_room_pin()',
       (SELECT count(*) = 2 FROM tbls WHERE name IN ('conversation_pins','room_pins'))
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'set_room_pin')),
  -- 0049 repaired a body, not a shape, so the only evidence is the column the
  -- membership check names. 0048's version asked `messages` for `m.sender_id`,
  -- which is room_messages' name for it, and failed only when somebody pinned
  -- something. Matching the comparison rather than the bare word on purpose:
  -- the repaired body still says `sender_id` in a comment explaining itself.
  (51, '0049_pin_sender_column',     'set_conversation_pin() compares messages.user_id, not sender_id',
       EXISTS (SELECT 1 FROM fns WHERE name = 'set_conversation_pin' AND src LIKE '%m.user_id = me%')
        AND NOT EXISTS (SELECT 1 FROM fns WHERE name = 'set_conversation_pin' AND src LIKE '%m.sender_id = me%')),
  (52, '0050_pin_realtime',          'both pin tables published, REPLICA IDENTITY FULL',
       (SELECT count(*) = 2 FROM pubs WHERE name IN ('conversation_pins','room_pins'))
        AND (SELECT count(*) = 2 FROM tbls
              WHERE name IN ('conversation_pins','room_pins') AND ri = 'f')),
  (53, '0051_expiry_sweeps_the_thumbnail', 'expire_messages() collects media_thumb_path too',
       EXISTS (SELECT 1 FROM fns WHERE name = 'expire_messages' AND src LIKE '%media_thumb_path%')),
  (54, '0052_grant_hygiene',         'no DELETE privilege on messages for client roles',
       NOT has_table_privilege('authenticated', 'public.messages', 'DELETE')),
  (55, '0053_blocks_and_reports',    'blocks + reports + is_blocked_pair(), blocks published',
       (SELECT count(*) = 2 FROM tbls WHERE name IN ('blocks','reports'))
        AND EXISTS (SELECT 1 FROM fns WHERE name = 'is_blocked_pair')
        AND EXISTS (SELECT 1 FROM pubs WHERE name = 'blocks')),
  (56, '0054_expiry_past_the_storage_guard', 'expire_messages() sets storage.allow_delete_query',
       EXISTS (SELECT 1 FROM fns WHERE name = 'expire_messages' AND src LIKE '%allow_delete_query%')),

  -- Not migrations, but the same question: applied by hand, and nothing
  -- complains when they were not.
  (90, '(storage) storage/setup.sql', 'avatars + chat-media + stickers buckets exist',
       (SELECT count(*) = 3 FROM bkts WHERE name IN ('avatars','chat-media','stickers'))),
  (91, '(extension) pg_cron',        'pg_cron installed — 0029''s sweep needs it',
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')),
  (92, '(extension) pg_net',         'pg_net installed — 0014''s push trigger needs it',
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')),
  (93, '(rls) every public table',   'no table in public has RLS switched off',
       NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity))
),
graded AS (
  SELECT ord, migration, proves,
         CASE WHEN ok IS NULL THEN 'n/a' WHEN ok THEN 'OK' ELSE 'MISSING' END AS status
    FROM checks
)
SELECT status, file, proves FROM (
  SELECT '— SUMMARY —' AS status,
         count(*) FILTER (WHERE status = 'MISSING')::text || ' missing, '
           || count(*) FILTER (WHERE status = 'OK')::text || ' ok, '
           || count(*) FILTER (WHERE status = 'n/a')::text || ' unobservable' AS file,
         CASE WHEN count(*) FILTER (WHERE status = 'MISSING') = 0
              THEN 'nothing obviously missing — npm run db:audit is the fact-by-fact check'
              ELSE 'apply the MISSING files below, in apply-order.txt order' END AS proves,
         0 AS ord
    FROM graded
  UNION ALL
  SELECT status, migration, proves, ord FROM graded
) board
ORDER BY ord;

-- pg_cron's schedule cannot be read in the same statement (querying cron.job
-- fails to parse where the extension is absent). If row 91 says OK, run this
-- on its own to see whether 0029's sweep is actually scheduled and enabled:
--
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'nearside-expire';
