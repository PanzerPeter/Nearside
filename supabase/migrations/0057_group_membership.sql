/*
  Nearside — a group can be changed after it is made

  Applied after 0056. Two new columns on `rooms`, two functions, two
  triggers, and one policy replaced.

  Until now a group was fixed at creation. Nobody could be added after the
  first screen (although `participants_insert_creator` has always allowed
  the owner to), and the title could never change, because `rooms` has no
  UPDATE policy. The leave dialog even told people "somebody still in it would
  have to add you back", which nothing in the app could do.

  Adding someone is client work and needs nothing new here: the owner inserts
  the participant row and seals the room key to them, the same two writes a
  group's creation makes. What this file adds is what has to be true on the
  server once members can arrive later.

  1. A newcomer reads from the moment they joined. `room_messages` was
     readable by any member, so a person added today would have been handed
     every message the group ever sent, by people who wrote them to a
     different set of readers. `room_member_since()` is the reader's own
     `joined_at`, and the SELECT policy compares against it.

     This is the server keeping it from them, not the cryptography: there is
     one room key, and a newcomer holds it. The same is already true of
     removal, and SECURITY.md says so for both.

  2. The two timestamps that boundary compares are the server's. `joined_at`
     and `room_messages.created_at` were both writable on insert, so a client
     could backdate a member into the group's history or backdate a message out
     of a newer member's view. Both are stamped on insert now. Nothing in the
     app ever sent either column.

  3. `set_room_title()`, for any member, the same rule as the group picture.
     It records who renamed it and when, in the same shape as the timer, so
     the thread can show one line saying so. A title is still plaintext: it
     names the group in notifications, and the transparency screen already
     lists it as readable.
*/

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS title_set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS title_set_at timestamptz;

-- ---------------------------------------------------------------------------
-- When the caller joined a room, or null when they are not in it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.room_member_since(target uuid)
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT p.joined_at FROM public.room_participants p
   WHERE p.room_id = target AND p.user_id = (SELECT auth.uid());
$$;

REVOKE ALL ON FUNCTION public.room_member_since(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_member_since(uuid) TO authenticated;

-- A null from the function (not a member) makes the comparison null, and a
-- null USING clause denies the row: the membership check is the same check.
DROP POLICY IF EXISTS room_messages_select_member ON public.room_messages;
CREATE POLICY room_messages_select_member ON public.room_messages
  FOR SELECT TO authenticated
  USING (created_at >= public.room_member_since(room_id));

-- ---------------------------------------------------------------------------
-- The server's clock on both sides of that comparison.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.room_participants_stamp_joined()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.joined_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_participants_stamp_joined() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_participants_stamp_joined ON public.room_participants;
CREATE TRIGGER room_participants_stamp_joined
  BEFORE INSERT ON public.room_participants
  FOR EACH ROW EXECUTE FUNCTION public.room_participants_stamp_joined();

CREATE OR REPLACE FUNCTION public.room_messages_stamp_created()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_messages_stamp_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_stamp_created ON public.room_messages;
CREATE TRIGGER room_messages_stamp_created
  BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.room_messages_stamp_created();

-- ---------------------------------------------------------------------------
-- Renaming a group.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_room_title(target uuid, new_title text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := auth.uid();
  cleaned text := btrim(coalesce(new_title, ''));
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  -- The title is drawn on one line in the list, the header and every
  -- notification, so a newline would break all three. The length rule is the
  -- table's own CHECK, which still applies to this UPDATE.
  IF cleaned ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'a group name is one line';
  END IF;

  UPDATE public.rooms
     SET title        = cleaned,
         title_set_by = me,
         title_set_at = now()
   WHERE id = target;
END;
$$;

REVOKE ALL ON FUNCTION public.set_room_title(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_title(uuid, text) TO authenticated;
