/*
  Nearside — disappearing messages

  Applied after 0028. Note that apply order in this folder is not numeric
  order; this file depends on 0026 (rooms) and 0023 (no body column) and on
  nothing applied after it.

  Contents:
    1. conversation_timers  — one timer per participant pair
    2. rooms.ttl_seconds    — the same idea for a room
    3. expires_at columns   — stamped by trigger, never by the client
    4. set_conversation_timer / set_room_timer — the only write paths
    5. expire_messages()    — the hard delete, run by pg_cron every minute

  Why the row is deleted rather than flagged:
    A tombstone is a row that still exists. "What the server knows" lists every
    row keyed to the user, so a flagged-but-present message would have to appear
    there, and it would be right to. Deleting is the only version of this
    feature that survives the app's own transparency screen.

  Why a BEFORE INSERT trigger rather than a client-supplied column:
    A timer the sender can decline to honour is not a timer. The trigger reads
    the conversation's own setting and overwrites whatever arrived, so a
    modified client sending into a timed conversation still gets stamped.

  Why the pair is normalized:
    least/greatest gives exactly one row per conversation regardless of who
    sets it, so the two sides cannot end up holding different timers. The
    self-chat (user_a = user_b) is allowed for the same reason 0017 allows a
    message addressed to yourself.

  What deletion does about attachments:
    An attachment's per-file key lives only in the message row's
    media_key_ciphertext. Deleting the row destroys the key, so the ciphertext
    left in storage is unopenable by anyone, including the server. The storage
    row is deleted too, best effort; a backing object that outlives it is
    undecryptable rather than merely unlisted.
*/

-- 1. Timers ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.conversation_timers (
  user_a      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ttl_seconds integer,
  set_by      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT timers_normalized CHECK (user_a <= user_b),
  CONSTRAINT timers_positive CHECK (ttl_seconds IS NULL OR ttl_seconds > 0)
);

ALTER TABLE public.conversation_timers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timers_select_participant ON public.conversation_timers;
CREATE POLICY timers_select_participant ON public.conversation_timers
  FOR SELECT TO authenticated
  USING (auth.uid() IN (user_a, user_b));

-- No INSERT or UPDATE policy: writes go through set_conversation_timer(),
-- which is the only thing that can normalize the pair correctly and record
-- who changed it.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS ttl_seconds integer,
  ADD COLUMN IF NOT EXISTS ttl_set_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_ttl_positive;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_ttl_positive CHECK (ttl_seconds IS NULL OR ttl_seconds > 0);

-- 2. The stamped column ------------------------------------------------------

ALTER TABLE public.messages      ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.room_messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Partial: the overwhelming majority of rows never expire, and a full index
-- on a mostly-null column costs writes to answer a question about a minority.
CREATE INDEX IF NOT EXISTS messages_expiring
  ON public.messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_messages_expiring
  ON public.room_messages (expires_at) WHERE expires_at IS NOT NULL;

-- 3. Stamping ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.stamp_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ttl integer;
BEGIN
  SELECT t.ttl_seconds INTO ttl
  FROM public.conversation_timers t
  WHERE t.user_a = least(NEW.user_id, NEW.receiver_id)
    AND t.user_b = greatest(NEW.user_id, NEW.receiver_id);

  -- Assigned unconditionally, so a client that supplied its own value has it
  -- replaced. That overwrite is the whole point of doing this here.
  NEW.expires_at := CASE WHEN ttl IS NULL THEN NULL ELSE now() + make_interval(secs => ttl) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_stamp_expiry ON public.messages;
CREATE TRIGGER messages_stamp_expiry
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_message_expiry();

CREATE OR REPLACE FUNCTION public.stamp_room_message_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ttl integer;
BEGIN
  SELECT r.ttl_seconds INTO ttl FROM public.rooms r WHERE r.id = NEW.room_id;
  NEW.expires_at := CASE WHEN ttl IS NULL THEN NULL ELSE now() + make_interval(secs => ttl) END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS room_messages_stamp_expiry ON public.room_messages;
CREATE TRIGGER room_messages_stamp_expiry
  BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_room_message_expiry();

-- 4. The write paths ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_conversation_timer(peer uuid, ttl integer)
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
  IF ttl IS NOT NULL AND ttl <= 0 THEN
    RAISE EXCEPTION 'timer must be positive or null';
  END IF;

  INSERT INTO public.conversation_timers (user_a, user_b, ttl_seconds, set_by, updated_at)
  VALUES (least(me, peer), greatest(me, peer), ttl, me, now())
  ON CONFLICT (user_a, user_b) DO UPDATE
    SET ttl_seconds = EXCLUDED.ttl_seconds,
        set_by      = EXCLUDED.set_by,
        updated_at  = EXCLUDED.updated_at;
END;
$$;

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
     SET ttl_seconds = ttl, ttl_set_by = me
   WHERE id = target;
END;
$$;

REVOKE ALL ON FUNCTION public.set_conversation_timer(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_timer(uuid, integer)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_conversation_timer(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_room_timer(uuid, integer)         TO authenticated;

-- The trigger functions are fired by the executor, never called by name.
REVOKE ALL ON FUNCTION public.stamp_message_expiry()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stamp_room_message_expiry() FROM PUBLIC, anon, authenticated;

-- 5. The sweep ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed text[];
BEGIN
  SELECT coalesce(array_agg(media_path), '{}')
    INTO doomed
    FROM public.messages
   WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Best effort. The row above held the only copy of this file's key, so the
  -- bytes are already unopenable; this reclaims the listing.
  IF array_length(doomed, 1) > 0 THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'chat-media' AND name = ANY (doomed);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;

/*
  Run these two statements separately, once, in the SQL editor. pg_cron must be
  enabled on the project first (Database → Extensions → pg_cron), and
  cron.schedule fails with a duplicate-jobname error if re-run, which is why it
  is not in the block above.

    SELECT cron.schedule(
      'nearside-expire',
      '* * * * *',
      $cron$ SELECT public.expire_messages(); $cron$
    );

  To change it later:

    SELECT cron.unschedule('nearside-expire');
*/
