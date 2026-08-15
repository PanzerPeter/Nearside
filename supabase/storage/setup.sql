/*
  Nearside — Storage buckets & policies
  Run once in the Supabase SQL editor AFTER 0001_init.sql.

  Buckets:
    avatars     — public read; each user writes only to their own folder ({uid}/...)
    chat-media  — private; only the two conversation participants can read/write.
                  Path convention: {sortedUidA}_{sortedUidB}/{uuid.ext}
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
