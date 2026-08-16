/*
  Nearside — room messages send a push

  Applied after 0036.

  `notify_push_on_message` is AFTER INSERT ON public.messages. Room messages
  were never covered by it and no client path invoked the function for one
  either, so a group has been silent since it shipped: no banner, no wake,
  nothing. Every parity feature in 0036 is invisible to somebody whose phone
  never told them the message arrived.

  Two tables come with it, and they are separate from the 1:1 ones rather than
  reused, because both are keyed on a foreign key that cannot hold a room:
  `message_pushes.message_id` references `messages`, and `push_alerts` is keyed
  on a *sender*. A room's cooldown has to be per room — a busy group is one
  conversation, and six people talking in it must not each carry their own
  30-second licence to make the same phone ring.

  The payload carries a room title and a sender's display name and no body,
  the same discipline the 1:1 push follows. The server holds neither the
  message nor the room key, so there is nothing else it could say.
*/

-- One row per room message that has been pushed, so the database trigger and a
-- client-side invoke can both fire without the room getting two banners.
CREATE TABLE IF NOT EXISTS public.room_message_pushes (
  message_id uuid PRIMARY KEY REFERENCES public.room_messages(id) ON DELETE CASCADE,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.room_message_pushes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_message_pushes FROM anon;
REVOKE ALL ON public.room_message_pushes FROM authenticated;

-- When a room last made a receiver's phone make a noise. Per room, not per
-- sender: see the header.
CREATE TABLE IF NOT EXISTS public.room_push_alerts (
  receiver_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  room_id     uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  alerted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receiver_id, room_id)
);
ALTER TABLE public.room_push_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_push_alerts FROM anon;
REVOKE ALL ON public.room_push_alerts FROM authenticated;

-- The 1:1 trigger, pointed at the other table. Same config row, same secret
-- header, same swallow-everything failure mode: a notification is never worth
-- failing a send over.
CREATE OR REPLACE FUNCTION public.notify_push_on_room_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cfg public.push_config%ROWTYPE;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cfg FROM public.push_config LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := cfg.function_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-secret', cfg.trigger_secret
               ),
    body    := jsonb_build_object('room_message_id', NEW.id),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_push_on_room_message() FROM PUBLIC, anon, authenticated;

-- No WHEN clause: there is no self-addressed room message. The fan-out in
-- `send-push` excludes the sender, which is where that exclusion belongs when
-- the audience is a participant list rather than one column.
DROP TRIGGER IF EXISTS notify_push_on_room_message ON public.room_messages;
CREATE TRIGGER notify_push_on_room_message
  AFTER INSERT ON public.room_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_push_on_room_message();

NOTIFY pgrst, 'reload schema';
