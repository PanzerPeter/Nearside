/*
  Nearside — two or three sounds while the conversation is happening

  Applied after 0037. Adds no feature, no policy and no new disclosure: one
  integer column on each of the two push-alert tables from 0035 and 0037.

  What it is for:

    0035 gave `send-push` somewhere to remember when it last made a phone make
    a noise, and the rule on top of it was one sound per conversation per
    thirty seconds. That fixed the buzzing and bought the opposite failure. A
    six-message burst arriving while the phone is in a pocket announced itself
    exactly once, and the next sound it was allowed to make came half a minute
    later, when the burst was over — so a message could easily be missed by
    somebody who had the app installed precisely so it would not be.

    The rule is now a ladder: ring at once, again after five seconds, again
    after fifteen, then one every forty for as long as it goes unread. The
    column below is how far up the ladder a conversation has climbed. It is
    reset (to 1) whenever the receiver catches up — their read watermark in
    `message_receipts` / `room_receipts` passing the message we last rang about
    — or after five minutes of silence.

  Why a column rather than counting notifications:

    The count that matters is alerts since the receiver last looked, and
    neither `message_pushes` nor `room_message_pushes` records which of its
    rows made a sound. Deriving it would mean keeping every push row forever
    and joining it against a watermark on every send; the anchor row already
    exists and is already overwritten in place.

    `streak` is a small integer clamped by the client to the ladder's length,
    so an old row written before this migration (defaulting to 1) simply starts
    at the bottom, which is the safe direction: a conversation that has been
    quiet gets heard.
*/

ALTER TABLE public.push_alerts
  ADD COLUMN IF NOT EXISTS streak integer NOT NULL DEFAULT 1;

ALTER TABLE public.room_push_alerts
  ADD COLUMN IF NOT EXISTS streak integer NOT NULL DEFAULT 1;

-- Both tables stay as locked down as 0035 and 0037 left them: RLS on with no
-- policy, and no grants to anon or authenticated. The Edge Function running as
-- the service role is the only reader and the only writer.
