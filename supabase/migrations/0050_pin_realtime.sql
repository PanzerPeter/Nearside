/*
  Nearside — a pin reaches the other person's screen

  Applied after 0049. No table, no policy, no new disclosure: the two pin
  tables from 0048 join the realtime publication, which is what 0048 forgot.

  What was wrong. Both clients subscribe to `postgres_changes` on
  `conversation_pins` / `room_pins` and re-read the row when one arrives —
  that subscription was answering a publication the tables were never in. The
  person who pinned saw the banner (their own client re-reads after the write)
  and nobody else did, until they next opened the conversation. A pin is a
  thing one person puts on everybody's screen; one that only the pinner can see
  is the feature not working.

  REPLICA IDENTITY FULL, like `message_reactions` and `room_message_reactions`
  before them: unpinning is a DELETE, and realtime evaluates the SELECT policy
  against the record in the event. Without the old row there is nothing to
  evaluate, so the DELETE is dropped and the peer's banner stays up pointing at
  a pin that no longer exists.

  Both tables are one row per conversation, overwritten in place, so FULL costs
  nothing worth counting in WAL.
*/

ALTER TABLE public.conversation_pins REPLICA IDENTITY FULL;
ALTER TABLE public.room_pins         REPLICA IDENTITY FULL;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_pins', 'room_pins'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;

-- 0048 created two tables without this, and a table created in the SQL editor
-- can stay invisible to the Data API until PostgREST reloads — which reads as
-- the pin silently never being there.
NOTIFY pgrst, 'reload schema';
