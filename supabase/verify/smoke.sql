-- Nearside — call the definer functions, once, against a built database.
--
-- Why this file exists. A plpgsql body is stored as text and resolved against
-- the catalog only when it runs. A function naming a column that does not
-- exist therefore applies without a word and fails on the first call, in
-- production, as a toast with no detail — which is exactly what 0048 did by
-- asking `messages` for `sender_id` (that is `room_messages`' name for the
-- sender; the 1:1 table calls it `user_id`). A catalog diff cannot see this:
-- both sides of the diff held the same wrong body.
--
-- So: minimal fixtures, one call per function that reads a column, and an
-- assertion on what it wrote. Everything happens inside a transaction that is
-- rolled back, so the databases being fingerprinted afterwards are untouched.
--
-- Run against both from_migrations and from_schema by verify.sh.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@verify.test'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@verify.test');

-- ON CONFLICT because a profile row already exists: 0001's trigger on
-- auth.users writes one for every account the moment it is created.
INSERT INTO public.profiles (id, display_name, public_key, signing_key) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice', 'pk-a', 'sk-a'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob',   'pk-b', 'sk-b')
ON CONFLICT (id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      public_key   = EXCLUDED.public_key,
      signing_key  = EXCLUDED.signing_key;

INSERT INTO public.messages (id, user_id, receiver_id, ciphertext, nonce) VALUES
  ('cccccccc-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'sealed', 'nonce');

INSERT INTO public.rooms (id, title, created_by) VALUES
  ('dddddddd-0000-0000-0000-000000000004', 'verify room',
   'aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.room_participants (room_id, user_id) VALUES
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.room_messages (id, room_id, sender_id, ciphertext, nonce, signature) VALUES
  ('eeeeeeee-0000-0000-0000-000000000005',
   'dddddddd-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-000000000001', 'sealed', 'nonce', 'sig');

-- The shim's auth.uid() reads this GUC. Alice is the caller throughout.
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

SELECT public.set_conversation_pin(
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003');

SELECT public.set_room_pin(
  'dddddddd-0000-0000-0000-000000000004',
  'eeeeeeee-0000-0000-0000-000000000005');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_pins
    WHERE message_id = 'cccccccc-0000-0000-0000-000000000003'
      AND pinned_by  = 'aaaaaaaa-0000-0000-0000-000000000001'
      -- least() of the two ids, which is what the normalizing is for.
      AND user_a     = 'aaaaaaaa-0000-0000-0000-000000000001'
      AND user_b     = 'bbbbbbbb-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'set_conversation_pin() wrote no usable row';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.room_pins
    WHERE room_id    = 'dddddddd-0000-0000-0000-000000000004'
      AND message_id = 'eeeeeeee-0000-0000-0000-000000000005'
      AND pinned_by  = 'aaaaaaaa-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'set_room_pin() wrote no usable row';
  END IF;
END;
$$;

-- A message from another conversation must be refused, not pinned. Without
-- this the pin could point the peer's client at a row their RLS will not open.
DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.set_conversation_pin(
      'bbbbbbbb-0000-0000-0000-000000000002',
      'eeeeeeee-0000-0000-0000-000000000005');
  EXCEPTION WHEN OTHERS THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'set_conversation_pin() accepted a message from another conversation';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- expire_messages(): the sweep takes BOTH objects, not just the full-size one.
--
-- 0044 gave every attachment a second object and did not teach this function
-- about it, so from 0044 to 0051 every expiring picture deleted its full-size
-- file and orphaned its preview — unopenable, uncollectable, and billed. A
-- catalog diff cannot see that: the body is stored as text and both sides of
-- the diff held the same wrong one.
--
-- `expires_at` is stamped by trigger on INSERT and frozen by the body guard on
-- UPDATE, which is the point of it — so there is no way to write a row that is
-- already expired except by taking the stamping trigger out of the way. The
-- triggers come back with the ROLLBACK.
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages      DISABLE TRIGGER messages_stamp_expiry;
ALTER TABLE public.room_messages DISABLE TRIGGER room_messages_stamp_expiry;

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-media', 'sweep/full.bin'),
  ('chat-media', 'sweep/thumb.bin'),
  ('chat-media', 'sweep/room-full.bin'),
  ('chat-media', 'sweep/room-thumb.bin'),
  -- A bystander: proof the sweep deletes what expired and not the bucket.
  ('chat-media', 'sweep/keep.bin');

INSERT INTO public.messages
  (id, user_id, receiver_id, media_path, media_thumb_path, media_type, expires_at)
VALUES
  ('cccccccc-0000-0000-0000-00000000000e',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'sweep/full.bin', 'sweep/thumb.bin', 'image', now() - interval '1 minute');

INSERT INTO public.room_messages
  (id, room_id, sender_id, signature, media_path, media_thumb_path, media_type, expires_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000000f',
   'dddddddd-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-000000000001', 'sig',
   'sweep/room-full.bin', 'sweep/room-thumb.bin', 'image', now() - interval '1 minute');

SELECT public.expire_messages();

DO $$
DECLARE
  orphan text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.messages
              WHERE id = 'cccccccc-0000-0000-0000-00000000000e')
     OR EXISTS (SELECT 1 FROM public.room_messages
                 WHERE id = 'eeeeeeee-0000-0000-0000-00000000000f') THEN
    RAISE EXCEPTION 'expire_messages() left an expired row behind';
  END IF;

  SELECT string_agg(name, ', ') INTO orphan
    FROM storage.objects
   WHERE bucket_id = 'chat-media'
     AND name IN ('sweep/full.bin', 'sweep/thumb.bin',
                  'sweep/room-full.bin', 'sweep/room-thumb.bin');
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'expire_messages() orphaned %', orphan;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.objects
                  WHERE bucket_id = 'chat-media' AND name = 'sweep/keep.bin') THEN
    RAISE EXCEPTION 'expire_messages() deleted an object no expired row named';
  END IF;
END;
$$;

ROLLBACK;
