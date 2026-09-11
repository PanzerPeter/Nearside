/*
  Nearside — the 1:1 pin function reads the column that exists

  Applied after 0048, which it repairs. Nothing else is altered: one
  CREATE OR REPLACE over `set_conversation_pin`, same signature, same grants.

  What was wrong. 0048's membership check asked `messages` for `sender_id`.
  That is `room_messages`' column; the 1:1 table has named the sender `user_id`
  since 0001. A plpgsql body is not resolved against the catalog until it runs,
  so the migration applied without complaint and every attempt to pin a message
  in a 1:1 conversation failed with `column m.sender_id does not exist` — which
  the client could only report as "Could not change the pinned message."

  Groups were unaffected: `set_room_pin` reads `room_messages.sender_id`, which
  is the right name there.

  The lesson worth keeping: a definer function that names a column is only
  proved by calling it, which is why `verify/smoke.sql` now does.
*/

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
      -- `user_id`, not `sender_id`: that is `room_messages`' name for the
      -- sender. 0048 shipped with the wrong one here and every 1:1 pin failed
      -- at runtime, because plpgsql does not resolve a body until it runs.
      AND ((m.user_id = me AND m.receiver_id = peer)
        OR (m.user_id = peer AND m.receiver_id = me))
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

-- CREATE OR REPLACE keeps the existing grants, but a function recreated on a
-- project that never ran 0048's grant block would be left executable by nobody.
REVOKE ALL ON FUNCTION public.set_conversation_pin(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_pin(uuid, uuid) TO authenticated;
