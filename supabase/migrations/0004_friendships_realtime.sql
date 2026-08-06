/*
  Chatly — friendships realtime
  Run once in the Supabase SQL editor after 0003.

  Contents:
    1. friendships REPLICA IDENTITY FULL — so realtime can evaluate RLS on the
       old row for UPDATE/DELETE (accept, decline, unfriend) events.
    2. Realtime — friendships added to the publication so friend requests and
       connection changes stream to clients live, without a page reload.

  Security notes:
    - RLS is already enabled on friendships (see 0001). Realtime honours the
      existing friendships_select_own policy, so a client only receives events
      for rows where it is the requester or addressee.
*/

-- Needed for realtime to apply RLS to the OLD row on UPDATE/DELETE.
ALTER TABLE public.friendships REPLICA IDENTITY FULL;

-- Stream friendship changes (requests, accepts, declines, removals) to clients.
-- No IF NOT EXISTS on ALTER PUBLICATION: a second run raises 42710 and aborts
-- the whole script. Guard it so this migration stays re-runnable, same as 0006.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'friendships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
  END IF;
END;
$$;
