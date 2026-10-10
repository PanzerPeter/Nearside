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

-- Real folders, not a made-up one: since 0055 a row may only name an object
-- in its own conversation's folder (or its own room's), which is what stops a
-- row pointing the sweep at somebody else's file.
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/full.bin'),
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/thumb.bin'),
  ('chat-media', 'dddddddd-0000-0000-0000-000000000004/room-full.bin'),
  ('chat-media', 'dddddddd-0000-0000-0000-000000000004/room-thumb.bin'),
  -- A bystander: proof the sweep deletes what expired and not the bucket.
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/keep.bin');

INSERT INTO public.messages
  (id, user_id, receiver_id, media_path, media_thumb_path, media_type, expires_at)
VALUES
  ('cccccccc-0000-0000-0000-00000000000e',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/full.bin',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/thumb.bin', 'image', now() - interval '1 minute');

INSERT INTO public.room_messages
  (id, room_id, sender_id, signature, media_path, media_thumb_path, media_type, expires_at)
VALUES
  ('eeeeeeee-0000-0000-0000-00000000000f',
   'dddddddd-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-000000000001', 'sig',
   'dddddddd-0000-0000-0000-000000000004/room-full.bin',
   'dddddddd-0000-0000-0000-000000000004/room-thumb.bin', 'image', now() - interval '1 minute');

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
     AND name IN ('aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/full.bin', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/thumb.bin',
                  'dddddddd-0000-0000-0000-000000000004/room-full.bin', 'dddddddd-0000-0000-0000-000000000004/room-thumb.bin');
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'expire_messages() orphaned %', orphan;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.objects
                  WHERE bucket_id = 'chat-media' AND name = 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/keep.bin') THEN
    RAISE EXCEPTION 'expire_messages() deleted an object no expired row named';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Blocks (0053), checked through RLS rather than around it: the policies are
-- the feature, so these run as `authenticated` with the caller set by claim.
--
-- The case worth a test is the one people get wrong. Both have blocked; one
-- unblocks; the conversation must stay shut, because the other row stands.
-- ---------------------------------------------------------------------------

INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'accepted');
INSERT INTO public.blocks (blocker_id, blocked_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';

-- Bob lifts his own block, and cannot lift Alice's.
DELETE FROM public.blocks WHERE blocker_id = 'bbbbbbbb-0000-0000-0000-000000000002';
DELETE FROM public.blocks WHERE blocker_id = 'aaaaaaaa-0000-0000-0000-000000000001';

DO $$
DECLARE
  refused boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.blocks
                  WHERE blocker_id = 'aaaaaaaa-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'blocks: the blocked person removed the blocker''s row';
  END IF;
  BEGIN
    INSERT INTO public.messages (user_id, receiver_id, ciphertext, nonce) VALUES
      ('bbbbbbbb-0000-0000-0000-000000000002',
       'aaaaaaaa-0000-0000-0000-000000000001', 'sealed', 'nonce');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'blocks: a message got through while the other side still blocks';
  END IF;
  -- The history stays readable to the blocked side.
  IF NOT EXISTS (SELECT 1 FROM public.messages
                  WHERE id = 'cccccccc-0000-0000-0000-000000000003') THEN
    RAISE EXCEPTION 'blocks: the blocked side lost the conversation history';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.set_conversation_pin(
      'bbbbbbbb-0000-0000-0000-000000000002',
      'cccccccc-0000-0000-0000-000000000003');
  EXCEPTION WHEN OTHERS THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'blocks: set_conversation_pin() pinned into a blocked conversation';
  END IF;
END;
$$;

-- Alice lifts hers; now nobody blocks and the conversation opens again.
DELETE FROM public.blocks WHERE blocker_id = 'aaaaaaaa-0000-0000-0000-000000000001';
INSERT INTO public.messages (user_id, receiver_id, ciphertext, nonce) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'sealed', 'nonce');

-- ---------------------------------------------------------------------------
-- Consent and folders (0055), through RLS like the block checks above.
--
-- Carol is a stranger to Alice: no friendship row, pending or otherwise. Each
-- block below is a write that used to succeed and must now be refused.
-- ---------------------------------------------------------------------------

RESET ROLE;
INSERT INTO auth.users (id, email) VALUES
  ('ffffffff-0000-0000-0000-000000000007', 'c@verify.test');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-media', 'dddddddd-0000-0000-0000-000000000004/victim.bin');
-- Bob has answered a sealed prompt; Alice has not. That ordering is exactly
-- what the exchange withholds from her.
INSERT INTO public.messages (id, user_id, receiver_id, ciphertext, nonce, sealed_prompt) VALUES
  ('cccccccc-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'sealed', 'nonce', true);
INSERT INTO public.sealed_answers (prompt_id, user_id, ciphertext, nonce) VALUES
  ('cccccccc-0000-0000-0000-000000000009', 'bbbbbbbb-0000-0000-0000-000000000002', 'sealed', 'nonce');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

DO $$
DECLARE
  refused boolean;
BEGIN
  -- A request is a question. Arriving already answered, it is a friendship
  -- with somebody who was never asked, and every policy trusts that row.
  refused := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000007', 'accepted');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'consent: a friendship was inserted already accepted';
  END IF;

  -- A room is not a way round the friendship gate: its owner may add
  -- themselves and their contacts, not whoever they have an id for.
  INSERT INTO public.rooms (id, title, created_by) VALUES
    ('12121212-0000-0000-0000-000000000008', 'consent room',
     'aaaaaaaa-0000-0000-0000-000000000001');
  INSERT INTO public.room_participants (room_id, user_id) VALUES
    ('12121212-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001'),
    ('12121212-0000-0000-0000-000000000008', 'bbbbbbbb-0000-0000-0000-000000000002');
  refused := false;
  BEGIN
    INSERT INTO public.room_participants (room_id, user_id) VALUES
      ('12121212-0000-0000-0000-000000000008', 'ffffffff-0000-0000-0000-000000000007');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'consent: a room owner added a stranger';
  END IF;

  -- A row names an object in its own folder and nowhere else. Otherwise a
  -- self-note on a short timer points the sweep at any file whose name is
  -- known, including a room's, which has no DELETE policy for that reason.
  refused := false;
  BEGIN
    INSERT INTO public.messages (user_id, receiver_id, media_path, media_type) VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
       'dddddddd-0000-0000-0000-000000000004/victim.bin', 'image');
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'folders: a message named an object outside its conversation';
  END IF;

  refused := false;
  BEGIN
    INSERT INTO public.room_messages (id, room_id, sender_id, signature, media_path, media_type)
    VALUES (gen_random_uuid(), '12121212-0000-0000-0000-000000000008',
            'aaaaaaaa-0000-0000-0000-000000000001', 'sig',
            'dddddddd-0000-0000-0000-000000000004/victim.bin', 'image');
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'folders: a room message named an object outside its room';
  END IF;

  -- The ordinary shapes still land: the self-chat folder is the pair of you.
  INSERT INTO public.messages (user_id, receiver_id, media_path, media_type) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
     'aaaaaaaa-0000-0000-0000-000000000001_aaaaaaaa-0000-0000-0000-000000000001/note.bin', 'image');

  -- Whether someone answered is theirs to reveal by answering, not a bit
  -- anybody can poll (0055).
  IF public.has_answered('cccccccc-0000-0000-0000-000000000009',
                         'bbbbbbbb-0000-0000-0000-000000000002') IS NOT FALSE THEN
    RAISE EXCEPTION 'has_answered: answered about someone other than the caller';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Read-receipt privacy (0056). `shares_read()` is there for one policy, which
-- asks it about a peer whose watermark row is addressed to the caller. Being
-- granted and in `public` it is also /rpc/shares_read, and it answered for any
-- id: a stranger could learn who had switched read receipts off.
--
-- Alice hides hers and Bob does not. Carol knows neither of them, so she must
-- get the same answer for both — and the guard must not take the feature
-- with it, so Alice and Bob still see exactly what the setting says.
-- ---------------------------------------------------------------------------

RESET ROLE;
INSERT INTO public.receipt_prefs (user_id, share_read) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', false);
INSERT INTO public.message_receipts (user_id, peer_id, read_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', now()),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', now());
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'ffffffff-0000-0000-0000-000000000007';

DO $$
BEGIN
  IF public.shares_read('aaaaaaaa-0000-0000-0000-000000000001')
     IS DISTINCT FROM public.shares_read('bbbbbbbb-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'shares_read: told a stranger who hides their read receipts';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.message_receipts
                  WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002'
                    AND peer_id = 'aaaaaaaa-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'receipts: a peer who shares read receipts was hidden';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.message_receipts
              WHERE user_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                AND peer_id = 'bbbbbbbb-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'receipts: a peer who hides read receipts was shown';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Group membership (0057). A member reads from the moment they joined, the
-- two timestamps that rule compares are the server's whatever a client sends,
-- and any member, but only a member, can rename the group.
--
-- One transaction means one now(), so "before they joined" is a row dated in
-- the past with the stamp trigger held off for that one insert — the way the
-- expiry fixtures above hold off theirs.
-- ---------------------------------------------------------------------------

RESET ROLE;
INSERT INTO public.rooms (id, title, created_by) VALUES
  ('34343434-0000-0000-0000-000000000010', 'membership room',
   'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.room_participants (room_id, user_id, joined_at) VALUES
  ('34343434-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', now()),
  ('34343434-0000-0000-0000-000000000010', 'bbbbbbbb-0000-0000-0000-000000000002',
   '2000-01-01T00:00:00Z');

ALTER TABLE public.room_messages DISABLE TRIGGER room_messages_stamp_created;
INSERT INTO public.room_messages (id, room_id, sender_id, ciphertext, nonce, signature, created_at)
VALUES ('56565656-0000-0000-0000-000000000011', '34343434-0000-0000-0000-000000000010',
        'aaaaaaaa-0000-0000-0000-000000000001', 'sealed', 'nonce', 'sig', '2001-01-01T00:00:00Z');
ALTER TABLE public.room_messages ENABLE TRIGGER room_messages_stamp_created;

INSERT INTO public.room_messages (id, room_id, sender_id, ciphertext, nonce, signature, created_at)
VALUES ('78787878-0000-0000-0000-000000000012', '34343434-0000-0000-0000-000000000010',
        'aaaaaaaa-0000-0000-0000-000000000001', 'sealed', 'nonce', 'sig', '2001-01-01T00:00:00Z');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.room_participants
              WHERE room_id = '34343434-0000-0000-0000-000000000010'
                AND joined_at <> now()) THEN
    RAISE EXCEPTION 'membership: joined_at took the client''s date';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.room_messages
                  WHERE id = '78787878-0000-0000-0000-000000000012' AND created_at = now()) THEN
    RAISE EXCEPTION 'membership: a room message kept the client''s created_at';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';

DO $$
DECLARE
  refused boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.room_messages
              WHERE id = '56565656-0000-0000-0000-000000000011') THEN
    RAISE EXCEPTION 'membership: a member read a message from before they joined';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.room_messages
                  WHERE id = '78787878-0000-0000-0000-000000000012') THEN
    RAISE EXCEPTION 'membership: a member could not read a message sent after they joined';
  END IF;

  PERFORM public.set_room_title('34343434-0000-0000-0000-000000000010', '  renamed  ');
  IF NOT EXISTS (SELECT 1 FROM public.rooms
                  WHERE id = '34343434-0000-0000-0000-000000000010'
                    AND title = 'renamed'
                    AND title_set_by = 'bbbbbbbb-0000-0000-0000-000000000002'
                    AND title_set_at IS NOT NULL) THEN
    RAISE EXCEPTION 'set_room_title() wrote no usable row';
  END IF;

  -- 0060: a sealed rename clears the plaintext and records who, and the
  -- one-time reseal neither records anybody nor touches a sealed name.
  PERFORM public.set_room_title_sealed('34343434-0000-0000-0000-000000000010', 'ct', 'nn');
  IF NOT EXISTS (SELECT 1 FROM public.rooms
                  WHERE id = '34343434-0000-0000-0000-000000000010'
                    AND title IS NULL AND title_ciphertext = 'ct'
                    AND title_set_by = 'bbbbbbbb-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'set_room_title_sealed() wrote no usable row';
  END IF;
  PERFORM public.seal_room_title('34343434-0000-0000-0000-000000000010', 'other', 'nn');
  IF NOT EXISTS (SELECT 1 FROM public.rooms
                  WHERE id = '34343434-0000-0000-0000-000000000010' AND title_ciphertext = 'ct') THEN
    RAISE EXCEPTION 'seal_room_title() replaced a name that was already sealed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rooms_for_me()
                  WHERE id = '34343434-0000-0000-0000-000000000010' AND title_ciphertext = 'ct') THEN
    RAISE EXCEPTION 'rooms_for_me() did not return the sealed name';
  END IF;

  refused := false;
  BEGIN
    PERFORM public.set_room_title('34343434-0000-0000-0000-000000000010', E'two\nlines');
  EXCEPTION WHEN raise_exception THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'set_room_title() accepted a name with a line break';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'ffffffff-0000-0000-0000-000000000007';

DO $$
DECLARE
  refused boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.room_messages
              WHERE room_id = '34343434-0000-0000-0000-000000000010') THEN
    RAISE EXCEPTION 'membership: somebody outside the group read its messages';
  END IF;

  refused := false;
  BEGIN
    PERFORM public.set_room_title('34343434-0000-0000-0000-000000000010', 'taken over');
  EXCEPTION WHEN raise_exception THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'set_room_title() let somebody outside the group rename it';
  END IF;
END;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- View-once (0058): only the recipient's call opens it, the opening clears the
-- key and deletes the object, and nobody can write `viewed_at` by hand.
-- ---------------------------------------------------------------------------

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/once.bin');

INSERT INTO public.messages
  (id, user_id, receiver_id, media_path, media_type, media_key_ciphertext, media_key_nonce, view_once)
VALUES
  ('cccccccc-0000-0000-0000-000000000058',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/once.bin',
   'image', 'k', 'n', true);

DO $$
DECLARE
  refused boolean := false;
BEGIN
  -- A thumbnail would outlive the deletion, so the shape refuses one.
  BEGIN
    INSERT INTO public.messages
      (user_id, receiver_id, media_path, media_thumb_path, media_type, view_once)
    VALUES
      ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002',
       'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/x.bin',
       'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/y.bin',
       'image', true);
  EXCEPTION WHEN check_violation THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'view_once: a view-once row was given a thumbnail';
  END IF;

  -- Setting it by hand is ignored, not obeyed.
  UPDATE public.messages SET viewed_at = now()
   WHERE id = 'cccccccc-0000-0000-0000-000000000058';
  IF EXISTS (SELECT 1 FROM public.messages
              WHERE id = 'cccccccc-0000-0000-0000-000000000058' AND viewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'view_once: viewed_at was written outside consume_view_once()';
  END IF;
END;
$$;

-- The sender cannot spend the recipient's one opening.
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT public.consume_view_once('cccccccc-0000-0000-0000-000000000058');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.messages
              WHERE id = 'cccccccc-0000-0000-0000-000000000058' AND viewed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'view_once: the sender consumed their own message';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
SELECT public.consume_view_once('cccccccc-0000-0000-0000-000000000058');
-- Twice, as a retry after a lost response would.
SELECT public.consume_view_once('cccccccc-0000-0000-0000-000000000058');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.messages
                  WHERE id = 'cccccccc-0000-0000-0000-000000000058'
                    AND viewed_at IS NOT NULL
                    AND media_key_ciphertext IS NULL
                    AND media_key_nonce IS NULL) THEN
    RAISE EXCEPTION 'consume_view_once() left the row openable';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects
              WHERE bucket_id = 'chat-media'
                AND name = 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/once.bin') THEN
    RAISE EXCEPTION 'consume_view_once() left the object in Storage';
  END IF;
END;
$$;

-- Deleting an opened one still works: a tombstone is always allowed.
UPDATE public.messages
   SET deleted_at = now(), media_path = NULL, media_type = NULL
 WHERE id = 'cccccccc-0000-0000-0000-000000000058';

-- ---------------------------------------------------------------------------
-- Profile keys (0061): granted only to somebody the profile row is shown to.
-- ---------------------------------------------------------------------------

RESET ROLE;
INSERT INTO auth.users (id, email) VALUES
  ('99999999-0000-0000-0000-000000000061', 'stranger@verify.test');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

INSERT INTO public.profile_keys (owner_id, reader_id, key_ciphertext, key_nonce)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'k', 'n');

DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.profile_keys (owner_id, reader_id, key_ciphertext, key_nonce)
    VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000061', 'k', 'n');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'profile_keys: a profile key was granted to a stranger';
  END IF;

  refused := false;
  BEGIN
    INSERT INTO public.profile_keys (owner_id, reader_id, key_ciphertext, key_nonce)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'k', 'n');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'profile_keys: somebody granted another person''s profile key';
  END IF;
END;
$$;

SET LOCAL request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profile_keys
                  WHERE owner_id = 'aaaaaaaa-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'profile_keys: the reader could not read their grant';
  END IF;
END;
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Write integrity (0062). `created_at` is the server's on insert, a sealed
-- question cannot be re-sealed, a message's objects leave with it — the
-- sender's only — and a 1:1 participant deletes only what they uploaded.
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('cccccccc-0000-0000-0000-0000000000c3', 'integrity@verify.test');

INSERT INTO public.messages (id, user_id, receiver_id, ciphertext, nonce, created_at) VALUES
  ('62626262-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'sealed', 'nonce', '2000-01-01T00:00:00Z');
INSERT INTO public.friendships (requester_id, addressee_id, status, created_at) VALUES
  ('cccccccc-0000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001',
   'pending', '2000-01-01T00:00:00Z');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.messages
                  WHERE id = '62626262-0000-0000-0000-000000000001' AND created_at = now()) THEN
    RAISE EXCEPTION 'integrity: a message kept the client''s created_at';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.friendships
                  WHERE requester_id = 'cccccccc-0000-0000-0000-0000000000c3'
                    AND created_at = now()) THEN
    RAISE EXCEPTION 'integrity: a friend request kept the client''s created_at';
  END IF;
END;
$$;

INSERT INTO public.messages (id, user_id, receiver_id, ciphertext, nonce, sealed_prompt) VALUES
  ('62626262-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002', 'question', 'nonce', true);

DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    UPDATE public.messages SET ciphertext = 'another question', nonce = 'n2'
     WHERE id = '62626262-0000-0000-0000-000000000002';
  EXCEPTION WHEN raise_exception THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'integrity: a sealed question was re-sealed';
  END IF;
  -- Withdrawing it is still a tombstone, and still allowed.
  UPDATE public.messages
     SET deleted_at = now(), ciphertext = NULL, nonce = NULL
   WHERE id = '62626262-0000-0000-0000-000000000002';
END;
$$;

INSERT INTO storage.objects (bucket_id, name, owner) VALUES
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine.bin',
   'aaaaaaaa-0000-0000-0000-000000000001'),
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine-thumb.bin',
   'aaaaaaaa-0000-0000-0000-000000000001'),
  ('chat-media', 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/theirs.bin',
   'bbbbbbbb-0000-0000-0000-000000000002'),
  ('chat-media', 'dddddddd-0000-0000-0000-000000000004/room-mine.bin',
   'aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.messages (id, user_id, receiver_id, media_path, media_thumb_path, media_type) VALUES
  ('62626262-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine.bin',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine-thumb.bin',
   'image'),
  -- Alice's row naming Bob's upload: clearing it must not delete his file.
  ('62626262-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/theirs.bin',
   NULL, 'image');
INSERT INTO public.room_messages (id, room_id, sender_id, media_path, media_type, signature) VALUES
  ('62626262-0000-0000-0000-000000000005', 'dddddddd-0000-0000-0000-000000000004',
   'aaaaaaaa-0000-0000-0000-000000000001',
   'dddddddd-0000-0000-0000-000000000004/room-mine.bin', 'image', 'sig');

UPDATE public.messages
   SET deleted_at = now(), media_path = NULL, media_type = NULL, media_thumb_path = NULL
 WHERE id IN ('62626262-0000-0000-0000-000000000003', '62626262-0000-0000-0000-000000000004');
UPDATE public.room_messages
   SET deleted_at = now(), media_path = NULL, media_type = NULL
 WHERE id = '62626262-0000-0000-0000-000000000005';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects
              WHERE name IN (
                'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine.bin',
                'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/mine-thumb.bin',
                'dddddddd-0000-0000-0000-000000000004/room-mine.bin')) THEN
    RAISE EXCEPTION 'integrity: a deleted message left its objects behind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects
                  WHERE name = 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/theirs.bin') THEN
    RAISE EXCEPTION 'integrity: clearing a row deleted an object somebody else uploaded';
  END IF;
END;
$$;

-- Alice tries to delete Bob's upload from their shared folder directly.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT set_config('storage.allow_delete_query', 'true', true);
DELETE FROM storage.objects
 WHERE name = 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/theirs.bin';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.objects
                  WHERE name = 'aaaaaaaa-0000-0000-0000-000000000001_bbbbbbbb-0000-0000-0000-000000000002/theirs.bin') THEN
    RAISE EXCEPTION 'integrity: a participant deleted the other person''s upload';
  END IF;
END;
$$;

ROLLBACK;
