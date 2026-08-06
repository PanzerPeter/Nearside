/*
  Chatly — Storage buckets & policies
  Run once in the Supabase SQL editor AFTER 0001_init.sql.

  Buckets:
    avatars     — public read; each user writes only to their own folder ({uid}/...)
    chat-media  — private; only the two conversation participants can read/write.
                  Path convention: {sortedUidA}_{sortedUidB}/{uuid.ext}

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

-- The audio types are the containers MediaRecorder produces across browsers
-- (Opus in WebM/Ogg on Chrome and Firefox, AAC in MP4 on Safari) — see
-- `pickAudioMime` in src/lib/audio.ts, which negotiates against this list.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-media', 'chat-media', false, 52428800,
        ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif',
              'video/mp4', 'video/webm', 'video/quicktime',
              'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg'])
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
