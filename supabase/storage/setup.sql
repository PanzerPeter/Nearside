/*
  Nearside — Storage buckets & policies
  Run once in the Supabase SQL editor AFTER 0001_init.sql.

  Buckets:
    avatars     — public read; each user writes only to their own folder ({uid}/...)
    chat-media  — private; only the two conversation participants can read/write.
                  Path convention: {sortedUidA}_{sortedUidB}/{uuid.ext}
                  Room attachments share the bucket under a different shape:
                  {roomId}/{uuid.ext}, gated on `is_room_member()`. A room id
                  is a bare uuid and a conversation folder always contains an
                  underscore, so the two cannot be mistaken for each other.
    stickers    — private; owner-only, every verb. Sealed under the owner's
                  vault key. Path convention: {uid}/{uuid}

  Upsert requires INSERT + SELECT + UPDATE (Supabase storage rule), so owners
  get all three on their own objects.
*/

-- ============================================================
-- Buckets
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 5242880,
        ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Attachments are sealed on the device and uploaded as opaque bytes, so
-- application/octet-stream is the only type they can be announced as — see
-- 0025_sealed_media_mime.sql, which this must not contradict. The image types
-- remain because chat backgrounds share this bucket and are not sealed.
--
-- The whitelist no longer says anything about what the sealed objects contain;
-- file_size_limit is the control still doing work here.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-media', 'chat-media', false, 52428800,
        ARRAY['application/octet-stream',
              'image/png', 'image/jpeg', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A sticker is sealed under the owner's vault key before it is uploaded, so
-- application/octet-stream is the only thing it can be announced as — the same
-- rule 0025 applies to attachments, for the same reason: a type header is a
-- description of contents this bucket is not supposed to have.
--
-- 1 MB is generous for a 512px webp and mean enough that the bucket cannot be
-- used as personal file storage.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('stickers', 'stickers', false, 1048576, ARRAY['application/octet-stream'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ============================================================
-- avatars policies  (folder = {uid})
-- A public bucket serves objects via their public URL without any SELECT
-- policy, so we intentionally do NOT add a broad read policy (that would only
-- let clients enumerate every avatar). Writes are still owner-scoped below.
--
-- We DO grant an owner-scoped SELECT: the client uploads with `upsert: true`,
-- and `INSERT ... ON CONFLICT DO UPDATE` needs SELECT on the conflicting row.
-- Without it the upload fails with "new row violates row-level security
-- policy". Owner scope keeps this from enabling enumeration of other avatars.
-- ============================================================
DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects;

DROP POLICY IF EXISTS "avatars_select_own" ON storage.objects;
CREATE POLICY "avatars_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
CREATE POLICY "avatars_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- chat-media policies  (folder = {uidA}_{uidB}, sorted)
-- Participant check: auth.uid() must be one of the two ids in the folder name.
-- ============================================================
DROP POLICY IF EXISTS "chat_media_read_participant" ON storage.objects;
CREATE POLICY "chat_media_read_participant" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND (select auth.uid())::text IN (
      split_part((storage.foldername(name))[1], '_', 1),
      split_part((storage.foldername(name))[1], '_', 2)
    )
  );

DROP POLICY IF EXISTS "chat_media_insert_participant" ON storage.objects;
CREATE POLICY "chat_media_insert_participant" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND (select auth.uid())::text IN (
      split_part((storage.foldername(name))[1], '_', 1),
      split_part((storage.foldername(name))[1], '_', 2)
    )
  );

DROP POLICY IF EXISTS "chat_media_delete_participant" ON storage.objects;
CREATE POLICY "chat_media_delete_participant" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND (select auth.uid())::text IN (
      split_part((storage.foldername(name))[1], '_', 1),
      split_part((storage.foldername(name))[1], '_', 2)
    )
  );

-- ============================================================
-- chat-media policies for rooms  (folder = {roomId})
--
-- Membership, not a pair, so the check is `is_room_member()` — which does not
-- exist yet when this file runs in its documented position (immediately after
-- 0001), and a policy body is analysed at CREATE time. Hence the guard: on a
-- fresh project built from schema.sql this file runs last and installs them,
-- and on a project built by replaying migrations they are installed by
-- 0036_room_parity.sql instead.
--
-- The two copies are word-for-word the same, and `npm run db:verify` is what
-- proves it: it builds a database each way and diffs the storage policies, so
-- editing one without the other fails the same way an edit to 0025 without an
-- edit here fails.
--
-- The CASE is what keeps this policy from raising on somebody else's upload:
-- `::uuid` on a conversation folder would error, and an error inside any
-- permissive policy fails the whole statement rather than just declining this
-- one. CASE is the only construct with a guaranteed evaluation order, so the
-- shape is checked before the cast happens.
--
-- There is no DELETE policy for a room folder on purpose. Attachments are
-- removed by `expire_messages()`, which runs as the owner — a member who could
-- delete objects directly could clear the room's history for everyone.
-- ============================================================
DO $room_media$
BEGIN
  IF to_regprocedure('public.is_room_member(uuid)') IS NULL THEN
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "chat_media_read_room_member" ON storage.objects;
  CREATE POLICY "chat_media_read_room_member" ON storage.objects
    FOR SELECT TO authenticated
    USING (
      bucket_id = 'chat-media'
      AND CASE
            WHEN (storage.foldername(name))[1] ~
                 '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN public.is_room_member(((storage.foldername(name))[1])::uuid)
            ELSE false
          END
    );

  DROP POLICY IF EXISTS "chat_media_insert_room_member" ON storage.objects;
  CREATE POLICY "chat_media_insert_room_member" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id = 'chat-media'
      AND CASE
            WHEN (storage.foldername(name))[1] ~
                 '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            THEN public.is_room_member(((storage.foldername(name))[1])::uuid)
            ELSE false
          END
    );
END;
$room_media$;

-- ============================================================
-- stickers policies  (folder = {uid})
-- Owner-only on every verb, with no participant branch of any kind.
--
-- A sticker's recipient never reads this bucket: sending one uploads a fresh
-- sealed copy into chat-media with its own key, so the library is not on the
-- delivery path. That is what lets it be completely private, and it is why
-- there is nothing to widen here later without a reason.
-- ============================================================
DROP POLICY IF EXISTS "stickers_select_own" ON storage.objects;
CREATE POLICY "stickers_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'stickers'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "stickers_insert_own" ON storage.objects;
CREATE POLICY "stickers_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'stickers'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- Upsert needs UPDATE alongside INSERT + SELECT (the Supabase storage rule
-- noted above for avatars), and a re-upload of the same sticker is an upsert.
DROP POLICY IF EXISTS "stickers_update_own" ON storage.objects;
CREATE POLICY "stickers_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'stickers'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'stickers'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );

DROP POLICY IF EXISTS "stickers_delete_own" ON storage.objects;
CREATE POLICY "stickers_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'stickers'
    AND (select auth.uid())::text = (storage.foldername(name))[1]
  );
