/*
  Nearside — rooms

  Numbered 0026, not the 0025 Plan 4 asked for: Plan 3 spent 0024 and 0025 on
  encrypted media. The number records order of application, and 0025 was taken.

  Contents:
    1. rooms              — one shared conversation
    2. room_participants  — membership and a stable per-room colour
    3. room_keys          — the room key, sealed once per member
    4. room_messages      — ciphertext, nonce, and the sender's signature
    5. rooms_for_me()     — the room list with member counts, one round trip

  Why room_keys is a table rather than a column:
    One symmetric key encrypts the room. Each member gets their own copy of it
    sealed to their published public key, so the server distributes a key it
    cannot open. Adding a member means adding one row, not re-encrypting the
    history.

  Why room_messages carries a signature:
    secretbox gives confidentiality, not authorship. Every member holds the
    room key, so any of them could write a message and the server's sender_id
    column would happily attest to whoever they claimed to be. The Ed25519
    signature over the ciphertext is what makes authorship cryptographic, and
    the client verifies it BEFORE decrypting.

  Why is_room_member() is SECURITY DEFINER:
    The obvious policy — "you may read a room if a row in room_participants
    says so" — recurses, because reading room_participants is itself gated on
    membership. A definer function reads the membership table with RLS off and
    returns a boolean, which is the standard way out of that loop and leaks
    nothing beyond the answer the policy was going to act on anyway.

  Removing a member:
    Deletes their participant row and their sealed key. They keep whatever
    they already downloaded, which is unavoidable and which the UI says at
    removal time, and they receive nothing further. Rotating the key for
    future messages is the client's job (see rooms.ts), because only a member
    can generate one.
*/

CREATE TABLE IF NOT EXISTS public.rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_title_length;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 60);

CREATE TABLE IF NOT EXISTS public.room_participants (
  room_id      uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  colour_index smallint NOT NULL DEFAULT 0,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_participants_user ON public.room_participants (user_id);

CREATE TABLE IF NOT EXISTS public.room_keys (
  room_id        uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_ciphertext text NOT NULL,
  key_nonce      text NOT NULL,
  sealed_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.room_messages (
  id         uuid PRIMARY KEY,
  room_id    uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  nonce      text NOT NULL,
  signature  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_messages_room_time
  ON public.room_messages (room_id, created_at DESC);

ALTER TABLE public.rooms             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_messages     ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_room_member(target uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_participants p
     WHERE p.room_id = target AND p.user_id = (SELECT auth.uid())
  );
$$;

CREATE OR REPLACE FUNCTION public.is_room_owner(target uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
     WHERE r.id = target AND r.created_by = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_room_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_room_owner(uuid)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_room_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_owner(uuid)  TO authenticated;

DROP POLICY IF EXISTS rooms_select_member ON public.rooms;
CREATE POLICY rooms_select_member ON public.rooms
  FOR SELECT TO authenticated USING (public.is_room_member(id));

DROP POLICY IF EXISTS rooms_insert_own ON public.rooms;
CREATE POLICY rooms_insert_own ON public.rooms
  FOR INSERT TO authenticated WITH CHECK (created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS rooms_delete_creator ON public.rooms;
CREATE POLICY rooms_delete_creator ON public.rooms
  FOR DELETE TO authenticated USING (created_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS participants_select_member ON public.room_participants;
CREATE POLICY participants_select_member ON public.room_participants
  FOR SELECT TO authenticated USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS participants_insert_creator ON public.room_participants;
CREATE POLICY participants_insert_creator ON public.room_participants
  FOR INSERT TO authenticated WITH CHECK (public.is_room_owner(room_id));

-- The creator removes members; anyone may remove themselves. Leaving is not a
-- privilege the room owner should be able to withhold.
DROP POLICY IF EXISTS participants_delete_owner_or_self ON public.room_participants;
CREATE POLICY participants_delete_owner_or_self ON public.room_participants
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_room_owner(room_id));

-- A member may read only their OWN sealed copy of the key. Reading someone
-- else's would be useless (it is sealed to their key) but there is no reason
-- to hand it over.
DROP POLICY IF EXISTS keys_select_own ON public.room_keys;
CREATE POLICY keys_select_own ON public.room_keys
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- Sealing is the room owner's job, and `sealed_by` must be the account doing
-- it: without the ownership half, any authenticated user could write a key row
-- into any room and hand a member a key of the attacker's choosing.
DROP POLICY IF EXISTS keys_insert_sealer ON public.room_keys;
CREATE POLICY keys_insert_sealer ON public.room_keys
  FOR INSERT TO authenticated
  WITH CHECK (sealed_by = (SELECT auth.uid()) AND public.is_room_owner(room_id));

DROP POLICY IF EXISTS keys_delete_owner ON public.room_keys;
CREATE POLICY keys_delete_owner ON public.room_keys
  FOR DELETE TO authenticated USING (public.is_room_owner(room_id));

DROP POLICY IF EXISTS room_messages_select_member ON public.room_messages;
CREATE POLICY room_messages_select_member ON public.room_messages
  FOR SELECT TO authenticated USING (public.is_room_member(room_id));

DROP POLICY IF EXISTS room_messages_insert_member ON public.room_messages;
CREATE POLICY room_messages_insert_member ON public.room_messages
  FOR INSERT TO authenticated
  WITH CHECK (sender_id = (SELECT auth.uid()) AND public.is_room_member(room_id));

/*
  The room list, in one round trip.

  Doing this client-side means one query for rooms, one for participants and
  one for the newest message per room, then a join in JavaScript — three
  requests on every sidebar refresh. It returns no message content: there is
  none the server could return.
*/
CREATE OR REPLACE FUNCTION public.rooms_for_me()
RETURNS TABLE (
  id           uuid,
  title        text,
  created_by   uuid,
  created_at   timestamptz,
  member_count bigint,
  last_at      timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT r.id,
         r.title,
         r.created_by,
         r.created_at,
         (SELECT count(*) FROM public.room_participants p WHERE p.room_id = r.id),
         (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id)
    FROM public.rooms r
   WHERE EXISTS (
           SELECT 1 FROM public.room_participants me
            WHERE me.room_id = r.id AND me.user_id = (SELECT auth.uid())
         )
   ORDER BY coalesce(
              (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id),
              r.created_at
            ) DESC;
$$;

REVOKE ALL ON FUNCTION public.rooms_for_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rooms_for_me() TO authenticated;

-- ALTER PUBLICATION ... ADD TABLE has no IF NOT EXISTS: a second run raises
-- 42710 and aborts the script. Guard it, same as 0001 and 0006 do.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'room_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_messages;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'room_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_participants;
  END IF;
END;
$$;
