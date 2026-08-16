/*
  Nearside — one sound per conversation, not one per message

  Applied after 0034. Adds no feature and changes no policy. It gives
  `send-push` somewhere to remember when it last made a receiver's phone make
  a noise, so a burst of messages arrives as one alert and a run of silent
  notifications rather than six buzzes while somebody finishes a sentence.

  Why a table and not a query over `messages`:

    The rule has to be anchored on the last *alert*, not on the last message.
    Derived from message timestamps, a steady stream just inside the window —
    someone typing every twenty seconds — has a predecessor in the window every
    single time, so that conversation goes silent and stays silent. Anchoring
    on the alert means the window is re-opened by the alert that closed it,
    which is the behaviour every other messenger has.

  What it holds, and why that is not a new disclosure:

    (receiver, sender, when we last rang). `messages` already holds who wrote
    to whom and at what second, for every message, and the transparency screen
    already says so. This is a strictly coarser shadow of that, one row per
    pair, overwritten in place — it adds nothing the server could not already
    answer, which is why the alternative (asking the client to tell the server
    which chat is open) was not taken: that one would.

  Locked down the way the other two push tables are: RLS on with no policy,
  which fails closed, plus the REVOKEs, so nothing but the service role reads
  or writes it. The Edge Function is the only caller.
*/

CREATE TABLE IF NOT EXISTS public.push_alerts (
  receiver_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Last time a notification for this pair was allowed to make a sound. Silent
  -- deliveries deliberately do not touch it: they are the ones inside the
  -- window, and moving the anchor for them is what would slide it forever.
  alerted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receiver_id, sender_id)
);

ALTER TABLE public.push_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.push_alerts FROM anon;
REVOKE ALL ON public.push_alerts FROM authenticated;
