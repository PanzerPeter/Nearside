/*
  Nearside — a group message can say it was passed along, and say it signed

  Applied after 0045. One column on `room_messages`, one CHECK widened, one
  immutability rule added to an existing trigger.

  Why it exists. Forwarding worked between one-to-one conversations only. A
  group could be neither a source nor a destination, which is backwards: a
  group is where a link or a photo most often needs to go next. `messages`
  has carried a `forwarded` flag since 0018 and renders a "Forwarded" notice
  from it; without the same column here, a message forwarded into a group
  arrives claiming to be the sender's own.

  Why the flag is inside the signature. `forwarded` is an attribution claim —
  it is the difference between somebody's own words and somebody passing along
  another conversation's. In a room the signature is the only thing that
  establishes authorship to a client at all (RLS is the server's promise, and
  this app does not trust the server with content), so a flag outside the
  payload is a flag the server can flip: clear it and a forward reads as
  original, set it and an original reads as borrowed. That is why this bumps
  `sig_v` to 4 rather than adding a plain column.

  Version 4 appends `forwarded` to the version 3 payload and changes nothing
  else. Every version 1, 2 and 3 signature keeps meaning exactly what it meant,
  and old rows keep verifying under their own version forever — the client
  picks the builder from the row's own `sig_v` and refuses a version it has no
  builder for rather than guessing at a shorter payload.

  Rollout. A client built before this migration has no version 4 builder, so it
  renders rows written by an updated client as `unverified` until it updates.
  That is the same cost 0044 paid for version 3, and it is the correct failure:
  an unrecognised version must never fall back to a payload that covers less.

  Why the column is immutable. `reply_to_id` is frozen by
  `room_messages_prevent_reassign` so that an edit cannot re-point a quote;
  `forwarded` is frozen for the same reason. An editable flag would let the
  sender of a forward strip the notice off it after the fact, and it would
  force every edit and every tombstone to re-sign over a value that had moved
  underneath them.
*/

ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;

-- A row claiming a version no builder exists for would verify against nothing
-- at all, so the set of known versions is stated here as well as in the client.
ALTER TABLE public.room_messages
  DROP CONSTRAINT IF EXISTS room_messages_sig_v_known;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_sig_v_known CHECK (sig_v IN (1, 2, 3, 4));

/*
  `forwarded` joins `room_id`, `sender_id` and `reply_to_id` as a column an
  UPDATE may not touch. The client's edit and delete paths both re-sign the
  whole row shape, and a value that could move between the read and the write
  would leave them signing a row the server does not hold.
*/
CREATE OR REPLACE FUNCTION public.room_messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id THEN
    RAISE EXCEPTION 'room_messages.room_id and room_messages.sender_id are immutable';
  END IF;
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
    RAISE EXCEPTION 'room_messages.reply_to_id is immutable';
  END IF;
  -- Frozen for the same reason: an editable flag would let the sender of a
  -- forward strip the notice off it after the fact, and it would move under
  -- the edit and delete paths, which both re-sign the whole row shape.
  IF NEW.forwarded IS DISTINCT FROM OLD.forwarded THEN
    RAISE EXCEPTION 'room_messages.forwarded is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.room_messages_prevent_reassign() FROM PUBLIC, anon, authenticated;
