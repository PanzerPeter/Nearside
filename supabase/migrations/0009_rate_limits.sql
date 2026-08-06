/*
  Chatly — flood limits
  Run once in the Supabase SQL editor after 0008.

  Contents:
    1. enforce_message_rate     — caps messages per sender per minute
    2. enforce_friendship_rate  — caps outbound friend requests per hour

  Why:
    Signup is invite-gated (0008), so this is not an anti-abuse perimeter —
    it is a runaway guard. A looping client or a buggy retry must not be able
    to fill the table, and a friend-request spammer among your invitees must
    hit a wall.

  Limits are intentionally far above human speed: a person typing fast sends
  perhaps 20 messages a minute, never 60.
*/

CREATE OR REPLACE FUNCTION public.enforce_message_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.messages m
  WHERE m.user_id = NEW.user_id
    AND m.created_at > now() - interval '1 minute';

  IF recent >= 60 THEN
    RAISE EXCEPTION 'rate_limited_messages';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_message_rate() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS messages_rate_limit ON public.messages;
CREATE TRIGGER messages_rate_limit
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_message_rate();

CREATE OR REPLACE FUNCTION public.enforce_friendship_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.friendships f
  WHERE f.requester_id = NEW.requester_id
    AND f.created_at > now() - interval '1 hour';

  IF recent >= 20 THEN
    RAISE EXCEPTION 'rate_limited_requests';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_friendship_rate() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS friendships_rate_limit ON public.friendships;
CREATE TRIGGER friendships_rate_limit
  BEFORE INSERT ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_friendship_rate();
