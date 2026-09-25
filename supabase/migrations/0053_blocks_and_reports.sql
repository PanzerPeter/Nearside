/*
  Nearside — blocking that the server enforces, and a place for reports

  Applied after 0052. Safe to re-run: every object is created IF NOT EXISTS or
  replaced, and every policy is dropped before it is recreated.

  ---------------------------------------------------------------------------
  Blocking

  Until now the only way to stop someone was "Delete chat", which ended the
  friendship and threw this device's copy of the conversation away with it.
  A block is the other half: the conversation stays, on both phones, readable,
  and nothing new can be written into it from either side.

  One row per direction. A blocks B is (A, B); B blocking A back is a second
  row, (B, A). Unblocking deletes only your own row, so when both people have
  blocked each other and one of them unblocks, the other row still stands and
  the conversation stays shut. `is_blocked_pair` asks about both directions,
  which is what every gate below calls.

  The friendship is left alone on purpose. It is what keeps the conversation
  in both lists and the history readable (`messages_select_participant` never
  looked at friendships), and it is what lets the blocked person still see who
  blocked them. The gates are on the writes:

    messages          no new message, no sealed question, and no edit — a
                      tombstone (delete for everyone) is still allowed, since
                      taking back your own words is not contact
    message_reactions no reaction on a message in a blocked conversation
    sealed_answers    no answer to a question in one
    friendships       no new request and no accepting one, so removing the
                      contact and asking again is not a way round the block
    set_conversation_pin / set_conversation_timer
                      no pin and no timer change: both put a line on the
                      other person's screen

  Calls are refused in `call-ring`, and the client drops a blocked peer from
  the set it listens for calls and presence on.

  The row is visible to both people. The blocked person is told, by design:
  a block that pretends to be a network fault leaves somebody retrying into
  silence. SELECT is therefore "either side of the row"; INSERT and DELETE are
  the blocker's alone.

  ---------------------------------------------------------------------------
  Reports

  `reports` is the ticket log, and nothing else. The complaint and the quoted
  messages go by email from the `report-user` function to the address it is
  configured with; they are never written to this database, which still holds
  no message body anywhere. What is kept is who reported whom and when —
  enough to see a pattern of reports against one account, and to rate-limit
  the function. No client role can read or write it.
*/

-- ===========================================================================
-- Blocks
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT no_self_block CHECK (blocker_id <> blocked_id)
);

-- The PK leads with blocker_id; this covers the other direction and the FK.
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON public.blocks (blocked_id);

/*
  Whether either of two people has blocked the other.

  SECURITY INVOKER, deliberately. Every caller in a policy is one of the two
  people, and the SELECT policy below already shows them both directions, so
  no elevated rights are needed — and a definer version would answer the
  question for any two accounts, to anyone who asked.
*/
CREATE OR REPLACE FUNCTION public.is_blocked_pair(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks bl
    WHERE (bl.blocker_id = a AND bl.blocked_id = b)
       OR (bl.blocker_id = b AND bl.blocked_id = a)
  );
$$;

REVOKE ALL ON FUNCTION public.is_blocked_pair(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_blocked_pair(uuid, uuid) TO authenticated;

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "blocks_select_party" ON public.blocks;
CREATE POLICY "blocks_select_party" ON public.blocks
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (blocker_id, blocked_id));

DROP POLICY IF EXISTS "blocks_insert_own" ON public.blocks;
CREATE POLICY "blocks_insert_own" ON public.blocks
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = blocker_id);

DROP POLICY IF EXISTS "blocks_delete_own" ON public.blocks;
CREATE POLICY "blocks_delete_own" ON public.blocks
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = blocker_id);

-- A block is placed or lifted, never edited.
REVOKE ALL ON public.blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.blocks TO authenticated;

-- ===========================================================================
-- The gates
-- ===========================================================================

-- The blocker can still read the profile of someone they blocked after
-- deleting the chat, so Settings can list them with a name and an Unblock.
DROP POLICY IF EXISTS "profiles_select_connected" ON public.profiles;
CREATE POLICY "profiles_select_connected" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE (f.requester_id = (select auth.uid()) AND f.addressee_id = profiles.id)
         OR (f.addressee_id = (select auth.uid()) AND f.requester_id = profiles.id)
    )
    OR EXISTS (
      SELECT 1 FROM public.blocks bl
      WHERE bl.blocker_id = (select auth.uid()) AND bl.blocked_id = profiles.id
    )
  );

DROP POLICY IF EXISTS "friendships_insert_own" ON public.friendships;
CREATE POLICY "friendships_insert_own" ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = requester_id
    AND NOT public.is_blocked_pair(requester_id, addressee_id)
  );

DROP POLICY IF EXISTS "friendships_update_addressee" ON public.friendships;
CREATE POLICY "friendships_update_addressee" ON public.friendships
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = addressee_id)
  WITH CHECK (
    (select auth.uid()) = addressee_id
    AND NOT public.is_blocked_pair(requester_id, addressee_id)
  );

DROP POLICY IF EXISTS "messages_insert_sender" ON public.messages;
CREATE POLICY "messages_insert_sender" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND receiver_id IS NOT NULL
    AND (
      -- The self-chat. No friendship exists or can exist for this pair.
      receiver_id = user_id
      OR (
        EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND (
              (f.requester_id = (select auth.uid()) AND f.addressee_id = receiver_id)
              OR (f.requester_id = receiver_id AND f.addressee_id = (select auth.uid()))
            )
        )
        AND NOT public.is_blocked_pair((select auth.uid()), receiver_id)
      )
    )
  );

-- An edit is a new body in front of the other person, so it is refused while
-- either side has blocked; a tombstone is not, and stays allowed.
DROP POLICY IF EXISTS "messages_update_sender" ON public.messages;
CREATE POLICY "messages_update_sender" ON public.messages
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK (
    (select auth.uid()) = user_id
    AND (deleted_at IS NOT NULL OR NOT public.is_blocked_pair(user_id, receiver_id))
  );

DROP POLICY IF EXISTS "reactions_insert_own" ON public.message_reactions;
CREATE POLICY "reactions_insert_own" ON public.message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND (select auth.uid()) IN (m.user_id, m.receiver_id)
        AND NOT public.is_blocked_pair(m.user_id, m.receiver_id)
    )
  );

DROP POLICY IF EXISTS "sealed_answers_insert_participant" ON public.sealed_answers;
CREATE POLICY "sealed_answers_insert_participant" ON public.sealed_answers
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (select auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = prompt_id
        AND m.sealed_prompt
        AND m.deleted_at IS NULL
        AND m.user_id <> m.receiver_id
        AND (select auth.uid()) IN (m.user_id, m.receiver_id)
        AND NOT public.is_blocked_pair(m.user_id, m.receiver_id)
    )
  );

/*
  The timer also gains the contact check it never had. Any signed-in account
  could call this with any peer id, and a contact removed from your list could
  go on changing the timer on the conversation you had with them — which the
  other side is shown as "X turned on disappearing messages".
*/
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
  -- Only a contact, and only while neither side has blocked (0053). Before,
  -- any account could call this with any peer id, and a contact removed from
  -- the list could go on changing the timer on the old conversation.
  IF peer <> me AND NOT EXISTS (
    SELECT 1 FROM public.friendships f
    WHERE f.status = 'accepted'
      AND ((f.requester_id = me AND f.addressee_id = peer)
        OR (f.requester_id = peer AND f.addressee_id = me))
  ) THEN
    RAISE EXCEPTION 'not a contact';
  END IF;
  IF public.is_blocked_pair(me, peer) THEN
    RAISE EXCEPTION 'conversation is blocked';
  END IF;

  INSERT INTO public.conversation_timers (user_a, user_b, ttl_seconds, set_by, updated_at)
  VALUES (least(me, peer), greatest(me, peer), ttl, me, now())
  ON CONFLICT (user_a, user_b) DO UPDATE
    SET ttl_seconds = EXCLUDED.ttl_seconds,
        set_by      = EXCLUDED.set_by,
        updated_at  = EXCLUDED.updated_at;
END;
$$;

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

  -- A pin is a line on the other person's screen; a block closes that too.
  IF public.is_blocked_pair(me, peer) THEN
    RAISE EXCEPTION 'conversation is blocked';
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

-- ===========================================================================
-- Reports
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_self_report CHECK (reporter_id <> reported_id)
);

-- The function's rate limit counts by reporter and time; the second index is
-- for reading a pattern against one account, and covers its FK.
CREATE INDEX IF NOT EXISTS reports_reporter_time ON public.reports (reporter_id, created_at);
CREATE INDEX IF NOT EXISTS reports_reported_idx  ON public.reports (reported_id);

-- No policy and no client grant: only `report-user`, on the service role,
-- writes or reads this table.
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- Realtime
-- ===========================================================================

-- FULL, because unblocking is a DELETE and realtime evaluates the SELECT
-- policy against the old row — without it the other side never hears the
-- block lift and stays shut out until the next refetch.
ALTER TABLE public.blocks REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'blocks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.blocks;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
