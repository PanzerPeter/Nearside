/*
  Nearside — voice messages
  Run once in the Supabase SQL editor after 0014.

  Adds 'audio' as a third kind of message media, plus the recorded length.

  Why the length is stored rather than read from the file:
    MediaRecorder produces a WebM stream with no duration in its header — an
    <audio> element reports Infinity for it until the whole object has been
    fetched and seeked to the end. A voice bubble has to show "0:14" before a
    byte of audio is downloaded, so the recorder's own wall-clock measurement
    is persisted with the message.

  The bound matches MAX_VOICE_MS in src/lib/audio.ts. Keep the two in sync: the
  client refuses to record past it, and this refuses to store past it.
*/

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_media_type_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_media_type_check
  CHECK (media_type IN ('image', 'video', 'audio'));

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_duration_ms integer;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS media_duration_range;

-- Only a voice note carries a duration, and only a positive one inside the
-- recording cap. A photo row with a duration would mean the client mislabelled
-- something, so it is rejected rather than stored.
ALTER TABLE public.messages
  ADD CONSTRAINT media_duration_range
  CHECK (
    media_duration_ms IS NULL
    OR (media_type = 'audio' AND media_duration_ms > 0 AND media_duration_ms <= 120000)
  );
