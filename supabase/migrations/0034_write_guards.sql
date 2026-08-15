/*
  Nearside — what an UPDATE is allowed to change

  Applied after 0033. Nothing here adds a feature. It closes the gap between
  what the policies were written to permit and what they actually permit,
  which in every case below is the same gap: a row-level policy sees one row
  at a time and cannot compare the new version against the old one. It can say
  "you may write this row"; it cannot say "you may write this row as long as
  these three columns stay where they are". `messages` already had a trigger
  for exactly that (0005). Everything else was relying on the client.

  The one that matters is the first. The rest are the same review carried
  through the tables that were written after it.
*/

-- ---------------------------------------------------------------------------
-- 1. Who a friendship is between
-- ---------------------------------------------------------------------------

/*
  `friendships_update_addressee` constrains addressee_id and nothing else. It
  is checked before and after the write, so the addressee stays the addressee —
  but `requester_id` is left free, and it is half of the pair the whole trust
  boundary is drawn from.

  The attack is three steps and needs no more than a second account:

    1. sign up as yourself twice, and have the second account send the first a
       friend request. You are now the addressee of a row you control.
    2. UPDATE that row: requester_id := <the person you want>, status :=
       'accepted'.
    3. the policy re-checks that you are still the addressee. You are.

  What you now hold is an accepted friendship with someone who was never asked.
  `messages_insert_sender` reads that row and lets you DM them;
  `profiles_select_connected` reads it and hands you their published keys;
  nicknames and chat backgrounds follow. The friend system is the only gate in
  front of any of it, and it was one UPDATE wide.

  There is no client fix for this — it is a REST call against a public schema —
  and no policy fix either, for the reason at the top of the file. So: a
  trigger, the same one `messages` has had since 0005.
*/
CREATE OR REPLACE FUNCTION public.friendships_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.addressee_id IS DISTINCT FROM OLD.addressee_id THEN
    RAISE EXCEPTION 'friendships.requester_id and friendships.addressee_id are immutable';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'friendships.created_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.friendships_prevent_reassign() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS friendships_prevent_reassign ON public.friendships;
CREATE TRIGGER friendships_prevent_reassign
  BEFORE UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.friendships_prevent_reassign();

-- ---------------------------------------------------------------------------
-- 2. One friendship per pair, whichever way round it was made
-- ---------------------------------------------------------------------------

/*
  `UNIQUE (requester_id, addressee_id)` dedupes an ordered pair, and a
  friendship is not ordered. A→B and B→A are two rows describing one
  relationship, and two people who add each other in the same minute create
  both — the client checks for the reverse row first, but a check-then-insert
  is not atomic and the second client reads before the first writes.

  Two rows is not a cosmetic duplicate. Removing a friend deletes the row the
  client knows about; the other one stays accepted, and the friendship the user
  believes they just ended still satisfies every policy that gates on it.
  `conversation_list()` hides the symptom — its DISTINCT ON collapses the peer
  to one sidebar entry — which is why this could sit here unnoticed.

  `conversation_timers` had the same problem to solve and solved it with
  least/greatest (0029). This is that, as an index.
*/

-- Any pre-existing pair. Accepted beats pending: it is the state a human
-- confirmed. Between two rows in the same state the older one survives, so the
-- outcome does not depend on which client happens to run this.
DELETE FROM public.friendships f
 USING public.friendships g
 WHERE least(f.requester_id, f.addressee_id) = least(g.requester_id, g.addressee_id)
   AND greatest(f.requester_id, f.addressee_id) = greatest(g.requester_id, g.addressee_id)
   AND f.id <> g.id
   AND (
     (f.status <> 'accepted' AND g.status = 'accepted')
     OR (f.status = g.status AND (f.created_at, f.id) > (g.created_at, g.id))
   );

CREATE UNIQUE INDEX IF NOT EXISTS friendships_unique_pair
  ON public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

-- The ordered `UNIQUE (requester_id, addressee_id)` stays, even though the
-- index above subsumes it as a constraint. It is the only index leading with
-- requester_id, and `profiles_select_connected` — evaluated for every profile
-- row anyone reads — looks a friendship up by exactly that column. Dropping it
-- as redundant would trade a rare write for a common sequential scan.

-- ---------------------------------------------------------------------------
-- 3. What a sender may still change about a sent message
-- ---------------------------------------------------------------------------

/*
  `reply_to_id` joins the columns 0005 froze. It is provenance like `forwarded`
  is: a reply that can be repointed afterwards makes the quoted message a
  choice the sender gets to revisit, in a thread the other person has already
  read.
*/
CREATE OR REPLACE FUNCTION public.messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'messages.user_id and messages.receiver_id are immutable';
  END IF;
  IF NEW.forwarded IS DISTINCT FROM OLD.forwarded THEN
    RAISE EXCEPTION 'messages.forwarded is immutable';
  END IF;
  IF NEW.sealed_prompt IS DISTINCT FROM OLD.sealed_prompt THEN
    RAISE EXCEPTION 'messages.sealed_prompt is immutable';
  END IF;
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id THEN
    RAISE EXCEPTION 'messages.reply_to_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

/*
  The body, and the three timestamps the server owns.

  A deletion is a tombstone rather than a DELETE (0023), which is only worth
  anything if the tombstone is final. `messages_update_sender` plus `has_body`
  let a sender clear `deleted_at` and write a fresh ciphertext in the same
  statement — the message the recipient watched turn into "deleted" comes back
  saying something else, with nothing on the row to show it ever went away.

  `edited_at` had the mirror-image problem: nothing required it. A sender could
  re-seal a body and leave the marker null, and the recipient would read the
  new text as the original. It is stamped here instead of being checked, so
  what the client sends does not matter — the same reason `expires_at` is
  stamped rather than validated (0029). The media trim in `useMediaSend`
  replaces a body with a "media removed" placeholder and will now mark those
  rows edited, which is what happened to them.

  `expires_at` and `created_at` are frozen for the same reason they are stamped
  by the server in the first place. A disappearing message whose sender can
  null its expiry afterwards does not disappear, and `created_at` is what
  read-receipt watermarks are compared against.
*/
CREATE OR REPLACE FUNCTION public.messages_body_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    IF NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be restored';
    END IF;
    IF NEW.ciphertext IS NOT NULL OR NEW.media_path IS NOT NULL THEN
      RAISE EXCEPTION 'a deleted message cannot be given a new body';
    END IF;
  END IF;

  IF NEW.deleted_at IS NULL
     AND (NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
          OR NEW.media_path IS DISTINCT FROM OLD.media_path) THEN
    NEW.edited_at := now();
  END IF;

  NEW.expires_at := OLD.expires_at;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.messages_body_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_body_guard ON public.messages;
CREATE TRIGGER messages_body_guard
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_body_guard();

/*
  And the row itself stops being deletable by the client.

  `messages_delete_sender` was never used — deleting a message goes through
  `tombstonePatch` and lands as an UPDATE — but while it stood, the tombstone
  was optional: a modified client could remove a row outright, which is a
  different thing from stripping it. The transparency screen lists rows keyed
  to you, receipts and reactions cascade off them, and the attachment left in
  Storage is orphaned rather than cleaned up (only `expire_messages()` deletes
  objects, and only for rows it expires).

  Revoked as a privilege as well as dropped as a policy, on the same reasoning
  as `theme_grants`: a policy added carelessly later should not be enough.
  Neither of the two paths that legitimately remove rows is affected —
  `expire_messages()` is SECURITY DEFINER and runs as the owner, and account
  deletion cascades from `auth.users` under the service role.
*/
DROP POLICY IF EXISTS "messages_delete_sender" ON public.messages;
REVOKE DELETE ON public.messages FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Removing a reaction, on the other device
-- ---------------------------------------------------------------------------

/*
  `message_reactions` is published to realtime and the client subscribes to its
  DELETE events, but the table was left on the default replica identity. A
  DELETE's old record is then the primary key and nothing else, so realtime
  evaluates `reactions_select_participant` — which reads `message_id` — against
  a row where `message_id` is null, decides nobody may see the event, and drops
  it. The removal reaches the server and never reaches the other person's
  screen until they reload.

  This is the reason the four tables in section 12 already carry it, applied to
  the one that was added before that section existed.

  `messages` deliberately does NOT get REPLICA IDENTITY FULL: nothing
  subscribes to DELETE on it, UPDATE events are authorized against the new
  record (which is complete either way), and FULL would copy every old
  ciphertext into the WAL on every edit for no event anyone is listening for.
*/
ALTER TABLE public.message_reactions REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- 5. Display names get the rules nicknames already had
-- ---------------------------------------------------------------------------

/*
  `friend_nicknames.nickname` is bounded and single-line because it is rendered
  inline in the sidebar and the chat header. `profiles.display_name` is
  rendered in the same places, by more people — a nickname is seen by one
  person, a display name by everyone you have connected with — and had neither
  rule. It arrives from `raw_user_meta_data`, which is whatever the signup
  request said, and can be rewritten to anything through `profiles_update_own`.

  The client already enforces exactly this (DISPLAY_NAME_MAX = 32, trimmed),
  which is what makes it safe to add: the constraint restates a rule the app
  has always followed, for the callers that are not the app.

  Uniqueness is still deliberately absent — see the note in schema.sql. A name
  that must be unique is an address, and this app has no directory.
*/

-- Nothing this client wrote can violate the constraints below, but a row
-- created before the client did, or by hand, can. Repaired rather than left to
-- fail the ALTER.
UPDATE public.profiles
   SET display_name = coalesce(
         nullif(btrim(left(btrim(regexp_replace(display_name, '[[:cntrl:]]+', ' ', 'g')), 32)), ''),
         'Someone'
       )
 WHERE display_name ~ '[[:cntrl:]]'
    OR char_length(btrim(display_name)) NOT BETWEEN 1 AND 32;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS display_name_length;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS display_name_single_line;
ALTER TABLE public.profiles
  ADD CONSTRAINT display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 32);
ALTER TABLE public.profiles
  ADD CONSTRAINT display_name_single_line CHECK (display_name ~ '^[^[:cntrl:]]+$');

/*
  The signup trigger repairs the name instead of handing it over as typed.

  Two failures it prevents, both of which surface identically. GoTrue collapses
  any error from this trigger to "Database error saving new user" and logs the
  cause where the person signing up cannot see it, so a name that trips a
  CHECK — or metadata with no name in it at all, which the NOT NULL column
  already rejected before today — reads to the user as "this app is broken".
*/
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  proposed text;
BEGIN
  proposed := coalesce(
    NEW.raw_user_meta_data->>'display_name',
    NEW.raw_user_meta_data->>'username',
    -- Not an address, just something better than a failed signup. It is the
    -- local part of what they typed, and Settings can change it immediately.
    split_part(coalesce(NEW.email, ''), '@', 1),
    ''
  );
  proposed := btrim(left(btrim(regexp_replace(proposed, '[[:cntrl:]]+', ' ', 'g')), 32));

  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, coalesce(nullif(proposed, ''), 'Someone'));
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. A room owner who is not in the room
-- ---------------------------------------------------------------------------

/*
  `is_room_owner()` asks `rooms.created_by`, which is permanent, while every
  other room privilege is checked against `room_participants`, which is not.
  A creator who removed themselves through `participants_delete_owner_or_self`
  kept the right to add members, seal and delete key rows and delete the room,
  while `rooms_select_member` stopped showing them the room at all.

  The fix is the smaller half: the creator cannot leave. It matches what the
  client already offers — `RoomView` shows the owner "Delete room" and everyone
  else "Leave room" — and it makes ownership and membership impossible to
  separate, since the creator's participant row can now only disappear with the
  room it belongs to.

  Making `is_room_owner()` require membership instead would have been the other
  half, and it deadlocks: `participants_insert_creator` calls it, and the
  creator's own participant row is inserted after the room and before anything
  else exists to be a member of.
*/
DROP POLICY IF EXISTS participants_delete_owner_or_self ON public.room_participants;
CREATE POLICY participants_delete_owner_or_self ON public.room_participants
  FOR DELETE TO authenticated
  USING (
    CASE WHEN public.is_room_owner(room_id)
         THEN user_id <> (SELECT auth.uid())
         ELSE user_id =  (SELECT auth.uid())
    END
  );

-- ---------------------------------------------------------------------------
-- 7. The rate limits the newer write paths never got
-- ---------------------------------------------------------------------------

/*
  `messages` and `friendships` are throttled; `room_messages` and
  `message_reactions` are not, and both are ordinary client inserts. The point
  is the same one 0009 made: this stops a loop, not a person. Sixty a minute is
  three times what someone typing fast produces, and a reaction is a tap.

  Each gets the index its counting query needs — neither table had one keyed on
  the writer, so the count would have been a sequential scan per insert that
  got slower as the table it protects grew.
*/
CREATE INDEX IF NOT EXISTS room_messages_sender_time
  ON public.room_messages (sender_id, created_at);

CREATE OR REPLACE FUNCTION public.enforce_room_message_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.room_messages m
  WHERE m.sender_id = NEW.sender_id
    AND m.created_at > now() - interval '1 minute';

  IF recent >= 60 THEN
    RAISE EXCEPTION 'rate_limited_messages';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_room_message_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_rate_limit ON public.room_messages;
CREATE TRIGGER room_messages_rate_limit
  BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_room_message_rate();

CREATE INDEX IF NOT EXISTS message_reactions_user_time
  ON public.message_reactions (user_id, created_at);

CREATE OR REPLACE FUNCTION public.enforce_reaction_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recent int;
BEGIN
  SELECT count(*) INTO recent
  FROM public.message_reactions r
  WHERE r.user_id = NEW.user_id
    AND r.created_at > now() - interval '1 minute';

  IF recent >= 60 THEN
    RAISE EXCEPTION 'rate_limited_reactions';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_reaction_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS message_reactions_rate_limit ON public.message_reactions;
CREATE TRIGGER message_reactions_rate_limit
  BEFORE INSERT ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reaction_rate();

-- ---------------------------------------------------------------------------
-- 8. The extension this schema has always assumed
-- ---------------------------------------------------------------------------

-- `mint_connect_code()` calls extensions.gen_random_bytes(). pgcrypto is
-- pre-installed on a Supabase project, so it has always been there and the
-- call has always worked — but this schema declares pg_trgm and pg_net and
-- said nothing about the one it actually depends on. Named, so the dependency
-- is a line in the file rather than a property of the host.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

NOTIFY pgrst, 'reload schema';
