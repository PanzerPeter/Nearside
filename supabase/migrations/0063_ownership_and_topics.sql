/*
  Nearside — objects only their uploader can lose, requests that see nothing,
  room attribution the server writes, signature version 5, and private
  realtime topics

  Applied after 0062. Two functions replaced, one function narrowed, one
  policy replaced and one function added beside it, one trigger added, one
  CHECK replaced, one function and two policies added on realtime.messages.
  Safe to re-run.

  Apply this BEFORE shipping 1.23.1. That build joins presence, typing and
  group channels as private topics, and a private join is refused until the
  policies in section 6 exist — presence and typing would go quiet. The other
  order is harmless: the policies govern private topics only, and the current
  app joins public ones.

  1. Only the uploader's objects leave with an expiring or opened message.
     0062 gave `drop_replaced_media()` that rule, so a member who repoints their
     own row at somebody else's file and clears it deletes nothing. The sweep
     and the view-once opening had no such check: set a one-second timer, post
     a row naming another member's photo, clear the timer, and the next minute's
     sweep deleted it — any group's media, despite a room folder having no
     DELETE policy, and in a 1:1 the other person's uploads, which 0062's
     storage policy had just stopped either of you deleting. A view-once row
     naming the recipient's own file did the same thing when they opened it.

  2. `has_friendship()` answers only about the caller. It is SECURITY DEFINER
     and in `public`, so it was /rpc/has_friendship for any two accounts: who is
     friends with whom, to anyone who asked. The only policy that calls it
     passes the caller as `owner_id`, so nothing that used it changes.

  3. A pending request shows the person who sent it, and nothing to them.
     `profiles_select_connected` treated any friendship row as a connection,
     and inserting one takes nothing but an id — no connect code — so a request
     from a stranger was enough to read the target's `last_seen_at`, keys and
     any profile column still in plaintext. The person who received the request
     still sees who it is from, which is what the pending branch was for. The
     sender keeps one thing, through `requested_public_key()`: the addressee's
     public key, which sealing their own profile to them takes.

  4. A new group's attribution is the server's. `ttl_set_by` and
     `title_set_by` drive "X set disappearing messages" and "X renamed the
     group" in the thread, and on INSERT they were whatever the creator wrote:
     a group could open with a line blaming somebody else for its timer.
     `created_at` goes with them, as it does on every other table since 0062.

  5. `room_messages.sig_v` may be 5: the signature now also covers the row's id
     and room id (`signedPayloadV5`), so a signed row inserted again under a
     fresh id no longer verifies.

  6. Presence, typing and group channels become private topics. Joined in
     public, `presence:{a}_{b}`, `dm:{a}_{b}` and `room:{id}` were open to anyone
     holding the anon key that ships in the app: knowing two ids was enough to
     watch somebody's status, or track one of your own under their id, or
     broadcast typing into their conversation. Postgres changes on the same
     channels are unaffected — they were always authorised per row by RLS on
     the table. The call topic stays public on purpose: its signals are sealed
     and checked (`openSignal`), and the lock-screen answer path joins it
     before the rest of the app has started.
*/

-- ---------------------------------------------------------------------------
-- 1. The uploader's objects only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doomed_paths   text[];
  doomed_senders uuid[];
BEGIN
  -- Both objects per row (0051), each with the account that sent the row: the
  -- delete below takes an object only if that account uploaded it (0063).
  SELECT coalesce(array_agg(path), '{}'), coalesce(array_agg(sender), '{}')
    INTO doomed_paths, doomed_senders
    FROM (
      SELECT unnest(ARRAY[media_path, media_thumb_path]) AS path, user_id AS sender
        FROM public.messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
      UNION ALL
      SELECT unnest(ARRAY[media_path, media_thumb_path]), sender_id
        FROM public.room_messages
       WHERE expires_at IS NOT NULL AND expires_at <= now() AND media_path IS NOT NULL
    ) expiring
   -- Null on a voice note and on every row written before 0044.
   WHERE expiring.path IS NOT NULL;

  DELETE FROM public.messages      WHERE expires_at IS NOT NULL AND expires_at <= now();
  DELETE FROM public.room_messages WHERE expires_at IS NOT NULL AND expires_at <= now();

  -- Spent and expired connect codes (0042). Expiry, not tidying: a token past
  -- `expires_at` is one `redeem_connect_code` already refuses, so nothing is
  -- taken away. Used codes are reachable only through this condition, which is
  -- what stops a redeemed code being minted again while it is still live.
  DELETE FROM public.connect_tokens WHERE expires_at < now();

  -- Best effort. The rows above held the only copies of these files' keys, so
  -- the bytes are already unopenable; this reclaims the listing.
  --
  -- The flag is what the Storage API sets for itself (0054). Without it the
  -- platform's `protect_delete` trigger raises, and the raise rolls back every
  -- delete above: expired messages stayed on the server, retried every minute.
  -- Transaction-local, so it opens nothing beyond this call.
  --
  -- The sender's uploads only, for the reason `drop_replaced_media()` gives: a
  -- row naming somebody else's file on a short timer was a way to delete it.
  IF array_length(doomed_paths, 1) > 0 THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects o
     USING unnest(doomed_paths, doomed_senders) AS d(path, sender)
     WHERE o.bucket_id = 'chat-media'
       AND o.name = d.path
       AND (o.owner = d.sender OR o.owner_id = d.sender::text);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_messages() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_view_once(target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  path   text;
  sender uuid;
BEGIN
  SELECT m.media_path, m.user_id INTO path, sender
    FROM public.messages m
   WHERE m.id = target
     AND m.receiver_id = (SELECT auth.uid())
     AND m.view_once
     AND m.viewed_at IS NULL
     AND m.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM set_config('nearside.consume_view_once', 'on', true);
  UPDATE public.messages
     SET viewed_at = now(),
         media_key_ciphertext = NULL,
         media_key_nonce = NULL
   WHERE id = target;
  PERFORM set_config('nearside.consume_view_once', 'off', true);

  -- The key is gone from the row above, so the bytes are already unopenable;
  -- this takes them off the server too. Same flag as expire_messages() (0054),
  -- and the same rule (0063): only an object the sender uploaded, or a
  -- view-once naming the recipient's own photo deleted it when they opened it.
  IF path IS NOT NULL THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects o
     WHERE o.bucket_id = 'chat-media'
       AND o.name = path
       AND (o.owner = sender OR o.owner_id = sender::text);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_view_once(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_view_once(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. has_friendship(), about the caller
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.has_friendship(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT (SELECT auth.uid()) IN (a, b) AND EXISTS (
    SELECT 1 FROM public.friendships f
     WHERE (f.requester_id = a AND f.addressee_id = b)
        OR (f.requester_id = b AND f.addressee_id = a)
  );
$$;

REVOKE ALL ON FUNCTION public.has_friendship(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_friendship(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. A pending request shows its sender, to its addressee
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles_select_connected" ON public.profiles;
CREATE POLICY "profiles_select_connected" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.friendships f
      -- Asked by me and accepted, or asked of me at any status: the person who
      -- received a request sees who sent it; the sender sees nobody until the
      -- answer is yes.
      WHERE (f.requester_id = (select auth.uid()) AND f.addressee_id = profiles.id
             AND f.status = 'accepted')
         OR (f.addressee_id = (select auth.uid()) AND f.requester_id = profiles.id)
    )
    OR EXISTS (
      SELECT 1 FROM public.blocks bl
      WHERE bl.blocker_id = (select auth.uid()) AND bl.blocked_id = profiles.id
    )
  );

/*
  The one thing a pending request's sender still needs: the addressee's public
  key, to seal their own profile key to them so the request shows who it is
  from. A connect code scanned off a screen carries it already; one typed in by
  hand does not, and the profile row is no longer theirs to read. A public key
  and nothing beside it — no `last_seen_at`, no profile column.
*/
CREATE OR REPLACE FUNCTION public.requested_public_key(peer uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.public_key
    FROM public.profiles p
   WHERE p.id = peer
     AND EXISTS (
       SELECT 1 FROM public.friendships f
        WHERE f.requester_id = (SELECT auth.uid())
          AND f.addressee_id = peer
          AND f.status = 'pending'
     );
$$;

REVOKE ALL ON FUNCTION public.requested_public_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.requested_public_key(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. A new group's attribution
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rooms_stamp_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.created_at   := now();
  -- A timer set at creation was set by the creator; a group still carrying the
  -- name it was made with has nobody to credit for renaming it.
  NEW.ttl_set_by   := CASE WHEN NEW.ttl_seconds IS NULL THEN NULL ELSE NEW.created_by END;
  NEW.ttl_set_at   := CASE WHEN NEW.ttl_seconds IS NULL THEN NULL ELSE now() END;
  NEW.title_set_by := NULL;
  NEW.title_set_at := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.rooms_stamp_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rooms_stamp_insert ON public.rooms;
CREATE TRIGGER rooms_stamp_insert
  BEFORE INSERT ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.rooms_stamp_insert();

-- ---------------------------------------------------------------------------
-- 5. Signature version 5
-- ---------------------------------------------------------------------------

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_sig_v_known;
ALTER TABLE public.room_messages
  ADD CONSTRAINT room_messages_sig_v_known CHECK (sig_v IN (1, 2, 3, 4, 5));

-- ---------------------------------------------------------------------------
-- 6. Private realtime topics
-- ---------------------------------------------------------------------------

/*
  Whether the caller may join a private topic, read off its name. A pair topic
  admits the two people it names and a group topic the group's members; a name
  of any other shape admits nobody. The CASE orders the shape check before the
  uuid cast, so a malformed topic is refused rather than raising.
*/
CREATE OR REPLACE FUNCTION public.may_join_topic(topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN topic ~ '^(presence|dm):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (SELECT auth.uid())::text IN (
             split_part(split_part(topic, ':', 2), '_', 1),
             split_part(split_part(topic, ':', 2), '_', 2))
    WHEN topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.is_room_member(split_part(topic, ':', 2)::uuid)
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.may_join_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_join_topic(text) TO authenticated;

-- Receiving (SELECT) and sending or tracking (INSERT), for broadcast and
-- presence. Nothing else is carried on these topics.
DROP POLICY IF EXISTS "nearside_topics_receive" ON realtime.messages;
CREATE POLICY "nearside_topics_receive" ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND public.may_join_topic((SELECT realtime.topic()))
  );

DROP POLICY IF EXISTS "nearside_topics_send" ON realtime.messages;
CREATE POLICY "nearside_topics_send" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND public.may_join_topic((SELECT realtime.topic()))
  );

NOTIFY pgrst, 'reload schema';
