/*
  Nearside — one message can be pinned to the top of a conversation

  Applied after 0047. Two tables and two definer functions. Nothing existing is
  altered.

  What it is for. A conversation accumulates one line that everybody in it keeps
  scrolling back for — an address, a door code, the time. Finding it again is
  the search feature working, which is to say it is three taps and a guess at a
  word. A pin is that line held at the top.

  Why the row holds an id and nothing else. The message is already in
  `messages` or `room_messages`, already sealed, already readable by exactly the
  people who should read it. A pin that carried a copy of the text would be a
  second copy of a body outside the encrypted column — the one thing 0023 exists
  to prevent — and it would go stale the moment the message was edited. So the
  pin is a pointer, the body stays where it is, and a client that cannot open
  the message cannot read the pin either. The server learns one more thing than
  before: which message somebody thought was important. That is disclosed on the
  transparency screen like every other column.

  One per conversation, not a list. A list of pins is a second thread, with its
  own ordering and its own way of getting long enough to need scrolling — at
  which point it is the conversation again. The primary key is the conversation,
  so pinning a second message replaces the first, which is also what makes
  "unpin" a thing you can do without finding the pinned message first.

  Why writes go through a function. `conversation_pins` is keyed by a normalized
  pair, exactly like `conversation_timers`, and a client cannot be trusted to
  order the pair or to say truthfully who pinned it. `room_pins` does not need
  normalizing but does need the membership check, and having the two written the
  same way is worth more than saving one function.

  ON DELETE CASCADE on the message: unpinning is not something anybody should
  have to remember to do before deleting the message that was pinned.
*/

-- ===========================================================================
-- One-to-one
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.conversation_pins (
  user_a     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  pinned_by  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  -- <= rather than <: the self-chat is a conversation like any other and can
  -- pin a note to itself like any other.
  CONSTRAINT pins_normalized CHECK (user_a <= user_b)
);

-- The PK indexes the pair; the message needs its own index for the FK's
-- cascade, which otherwise scans this table on every message delete.
CREATE INDEX IF NOT EXISTS conversation_pins_message_idx
  ON public.conversation_pins (message_id);

ALTER TABLE public.conversation_pins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_pins FROM anon;
-- No INSERT or UPDATE grant: writes go through `set_conversation_pin()`, which
-- is the only thing that can normalize the pair and record who pinned it.
-- DELETE is granted because unpinning has nothing to normalize — the row is
-- already found by the pair the reader is a member of.
GRANT SELECT, DELETE ON public.conversation_pins TO authenticated;

DROP POLICY IF EXISTS pins_select_participant ON public.conversation_pins;
CREATE POLICY pins_select_participant ON public.conversation_pins
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (user_a, user_b));

-- Either participant may unpin, deliberately. A pin is shown to both of them
-- and takes space at the top of both their screens; one person being able to
-- put something there that the other cannot remove is a small lever that does
-- not belong in a two-person app with no moderation.
DROP POLICY IF EXISTS pins_delete_participant ON public.conversation_pins;
CREATE POLICY pins_delete_participant ON public.conversation_pins
  FOR DELETE TO authenticated
  USING ((select auth.uid()) IN (user_a, user_b));

CREATE OR REPLACE FUNCTION public.set_conversation_pin(peer uuid, target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- The message must be one of this conversation's, not merely one the caller
  -- can see. Without this a pin could point the peer's client at a row from a
  -- different conversation — which their RLS would refuse to open, leaving a
  -- permanent unreadable banner at the top of their screen.
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = target
      AND m.deleted_at IS NULL
      AND ((m.sender_id = me AND m.receiver_id = peer)
        OR (m.sender_id = peer AND m.receiver_id = me))
  ) THEN
    RAISE EXCEPTION 'message is not part of that conversation';
  END IF;

  INSERT INTO public.conversation_pins (user_a, user_b, message_id, pinned_by, pinned_at)
  VALUES (least(me, peer), greatest(me, peer), target, me, now())
  ON CONFLICT (user_a, user_b) DO UPDATE
    SET message_id = EXCLUDED.message_id,
        pinned_by  = EXCLUDED.pinned_by,
        pinned_at  = EXCLUDED.pinned_at;
END;
$$;

-- ===========================================================================
-- Groups
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.room_pins (
  room_id    uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.room_messages(id) ON DELETE CASCADE,
  pinned_by  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_pins_message_idx
  ON public.room_pins (message_id);

ALTER TABLE public.room_pins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_pins FROM anon;
GRANT SELECT, DELETE ON public.room_pins TO authenticated;

DROP POLICY IF EXISTS room_pins_select_member ON public.room_pins;
CREATE POLICY room_pins_select_member ON public.room_pins
  FOR SELECT TO authenticated
  USING (public.is_room_member(room_id));

-- Any member may unpin, not only whoever pinned it and not only the owner.
-- Same reasoning as the 1:1 policy above: it is everybody's screen.
DROP POLICY IF EXISTS room_pins_delete_member ON public.room_pins;
CREATE POLICY room_pins_delete_member ON public.room_pins
  FOR DELETE TO authenticated
  USING (public.is_room_member(room_id));

CREATE OR REPLACE FUNCTION public.set_room_pin(target_room uuid, target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target_room) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.room_messages rm
    WHERE rm.id = target
      AND rm.room_id = target_room
      AND rm.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'message is not part of that room';
  END IF;

  INSERT INTO public.room_pins (room_id, message_id, pinned_by, pinned_at)
  VALUES (target_room, target, me, now())
  ON CONFLICT (room_id) DO UPDATE
    SET message_id = EXCLUDED.message_id,
        pinned_by  = EXCLUDED.pinned_by,
        pinned_at  = EXCLUDED.pinned_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_conversation_pin(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_pin(uuid, uuid)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_pin(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_room_pin(uuid, uuid)         TO authenticated;
