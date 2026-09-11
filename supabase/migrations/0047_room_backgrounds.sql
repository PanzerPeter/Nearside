/*
  Nearside — a group can have a background, and its timer says when

  Applied after 0046. One new table with its policies and grants, plus one
  column on `rooms` and the definer function that writes it (see the second
  half of this file). Nothing else is altered.

  Why a second table rather than a column on `chat_backgrounds`. That table is
  keyed `(owner_id, peer_id)` and `peer_id` is a foreign key into `profiles`.
  A room id is not a profile id, so it cannot go in that column without
  dropping the reference that keeps the table honest — and a nullable
  `room_id` beside a nullable `peer_id` is a primary key that can be half-set,
  which is the shape 0039 deliberately avoided for the key columns on the same
  table. Two tables, each with a real key and a real foreign key, is the
  cheaper thing to reason about.

  Why it is sealed, and sealed to the owner. Exactly the reasoning 0039 wrote
  down for one-to-one backgrounds, and it is stronger here. The object lives in
  the room's own storage folder, which `is_room_member()` opens to *every*
  member — that policy was written for attachments the group is meant to share.
  A background is not one: it is chosen by one person and shown to nobody else.
  So the file goes up as ciphertext under a random per-file key, and that key is
  sealed under the owner's vault key, on a row no other member's RLS lets them
  read. A member who lists the folder gets bytes they cannot open.

  There is deliberately no pre-seal compatibility case here, unlike 0039: no
  group background has ever existed, so there is no plaintext row to keep
  rendering. The key columns are therefore NOT NULL, which is the constraint
  0039 could not have.

  Leaving a group. The row is dropped with the room (ON DELETE CASCADE), and a
  member who leaves keeps a row pointing into a folder they can no longer read.
  That is the same end state as every other trace of a room a client keeps
  locally, and the picture simply stops loading; deleting it would mean a
  trigger on `room_members` whose only job is tidying somebody's wallpaper.
*/

CREATE TABLE IF NOT EXISTS public.room_backgrounds (
  owner_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL REFERENCES public.rooms(id)    ON DELETE CASCADE,
  media_path text NOT NULL,

  -- The image's file key, sealed under the owner's vault key. Not null: see
  -- the header — there are no pre-seal rows to be compatible with.
  key_ciphertext text NOT NULL,
  key_nonce      text NOT NULL,

  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, room_id),
  CONSTRAINT room_backgrounds_path_length CHECK (char_length(media_path) BETWEEN 1 AND 512)
);

-- The PK indexes (owner_id, room_id); room_id needs its own for the FK.
CREATE INDEX IF NOT EXISTS room_backgrounds_room_idx
  ON public.room_backgrounds (room_id);

ALTER TABLE public.room_backgrounds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_backgrounds FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.room_backgrounds TO authenticated;

DROP TRIGGER IF EXISTS room_backgrounds_set_updated_at ON public.room_backgrounds;
CREATE TRIGGER room_backgrounds_set_updated_at
  BEFORE UPDATE ON public.room_backgrounds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Your own row and nobody else's. A background is not shared, so there is no
-- case in which another member should see that one exists, let alone its path.
DROP POLICY IF EXISTS "room_backgrounds_select_own" ON public.room_backgrounds;
CREATE POLICY "room_backgrounds_select_own" ON public.room_backgrounds
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = owner_id);

-- Membership is checked on write as well as ownership: without it a row could
-- be planted for a room the writer has no part in, naming a path in that
-- room's folder.
DROP POLICY IF EXISTS "room_backgrounds_insert_own" ON public.room_backgrounds;
CREATE POLICY "room_backgrounds_insert_own" ON public.room_backgrounds
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = owner_id AND public.is_room_member(room_id));

-- Replacing a background is an upsert, so the same gate has to hold on UPDATE.
DROP POLICY IF EXISTS "room_backgrounds_update_own" ON public.room_backgrounds;
CREATE POLICY "room_backgrounds_update_own" ON public.room_backgrounds
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id)
  WITH CHECK ((select auth.uid()) = owner_id AND public.is_room_member(room_id));

-- Deliberately ownership only. Somebody removed from a group must still be
-- able to clear the row they left behind.
DROP POLICY IF EXISTS "room_backgrounds_delete_own" ON public.room_backgrounds;
CREATE POLICY "room_backgrounds_delete_own" ON public.room_backgrounds
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

/*
  While here: when the group's timer was last changed.

  `rooms.ttl_seconds` and `ttl_set_by` have existed since 0036 and the expiry
  trigger has read them since, but nothing recorded *when*. The thread draws a
  "disappearing messages are on" notice in its place in the conversation, and
  its place is decided by comparing that instant against each message's
  `created_at` — with no stamp the notice can only sit at the very top, above
  messages sent long before anybody turned the timer on.

  `rooms` has no `updated_at` to lean on, and adding a general one would mean a
  trigger firing on every title and avatar change for a column only this reads.

  Null on every existing row, which is the truthful answer: those timers were
  set before anything recorded the moment, and the client draws no notice
  rather than inventing one.
*/

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS ttl_set_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_room_timer(target uuid, ttl integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  IF ttl IS NOT NULL AND ttl <= 0 THEN
    RAISE EXCEPTION 'timer must be positive or null';
  END IF;

  UPDATE public.rooms
     SET ttl_seconds = ttl, ttl_set_by = me, ttl_set_at = now()
   WHERE id = target;
END;
$$;
