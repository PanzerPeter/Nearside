/*
  Nearside — consent before contact, and a row's objects in its own folder

  Applied after 0054. Two policies replaced, two CHECKs added, one function
  replaced. No table and no column.

  Preflight — run first; both must return 0, or the constraints below refuse
  to be added and the whole file rolls back, which is safe:

    SELECT count(*) FROM public.messages
     WHERE (media_path IS NOT NULL AND split_part(media_path, '/', 1)
              <> least(user_id, receiver_id)::text || '_' || greatest(user_id, receiver_id)::text)
        OR (media_thumb_path IS NOT NULL AND split_part(media_thumb_path, '/', 1)
              <> least(user_id, receiver_id)::text || '_' || greatest(user_id, receiver_id)::text);
    SELECT count(*) FROM public.room_messages
     WHERE (media_path IS NOT NULL AND split_part(media_path, '/', 1) <> room_id::text)
        OR (media_thumb_path IS NOT NULL AND split_part(media_thumb_path, '/', 1) <> room_id::text);

  1. `friendships_insert_own` checked who was asking and never what they
     asked for. `status` defaults to 'pending', and the client never sets it,
     but a request is a column like any other: inserted as 'accepted', it was
     a friendship with somebody who had never been asked — which is the one
     row `messages_insert_sender`, `profiles_select_connected` and
     `call-ring` all trust. All it took was the other person's id, and that id
     is in every connect QR and every avatar URL. An insert is now a request
     and nothing more; only the addressee can turn it into a friendship.

  2. `participants_insert_creator` let a room's owner add any account at all.
     That made a room the way round both gates above: somebody you had blocked
     could put you in a group and write to you there, with a push under a title
     of their choosing, and add you back every time you left. The owner may now
     add themselves and their own contacts, and nobody on either side of a
     block. The client already only offered contacts; this makes it true.

  3. `expire_messages()` deletes whatever objects an expiring row names, as the
     owner, and `media_path` was the client's word. A self-note on a one-second
     timer naming `{roomId}/photo.jpg` deleted another group's photo a minute
     later — the exact thing room folders have no DELETE policy to prevent. The
     same trust let a row point its recipient at an object in some other
     conversation. A row may now name only its own folder: the sorted pair for
     a message, the room id for a room message. That is the convention every
     client path already writes (`mediaPath`, `roomMediaPath`), so nothing
     legitimate changes.

  4. `has_answered()` is SECURITY DEFINER so the `sealed_answers` policy can
     ask about its own table, and it was executable by anyone for any pair of
     ids. The policy only ever asks about the caller. Asked about somebody
     else, it answered "have they answered yet?" — the ordering the sealed
     exchange exists to withhold. It now answers only for the caller.
*/

DROP POLICY IF EXISTS "friendships_insert_own" ON public.friendships;
CREATE POLICY "friendships_insert_own" ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = requester_id
    AND status = 'pending'
    AND NOT public.is_blocked_pair(requester_id, addressee_id)
  );

DROP POLICY IF EXISTS participants_insert_creator ON public.room_participants;
CREATE POLICY participants_insert_creator ON public.room_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_room_owner(room_id)
    AND (
      user_id = (SELECT auth.uid())
      OR (
        EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND ((f.requester_id = (SELECT auth.uid()) AND f.addressee_id = user_id)
              OR (f.requester_id = user_id AND f.addressee_id = (SELECT auth.uid())))
        )
        AND NOT public.is_blocked_pair((SELECT auth.uid()), user_id)
      )
    )
  );

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_media_in_conversation;
ALTER TABLE public.messages ADD CONSTRAINT messages_media_in_conversation CHECK (
  (media_path IS NULL
    OR split_part(media_path, '/', 1)
       = least(user_id, receiver_id)::text || '_' || greatest(user_id, receiver_id)::text)
  AND (media_thumb_path IS NULL
    OR split_part(media_thumb_path, '/', 1)
       = least(user_id, receiver_id)::text || '_' || greatest(user_id, receiver_id)::text)
);

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_media_in_room;
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_media_in_room CHECK (
  (media_path IS NULL OR split_part(media_path, '/', 1) = room_id::text)
  AND (media_thumb_path IS NULL OR split_part(media_thumb_path, '/', 1) = room_id::text)
);

CREATE OR REPLACE FUNCTION public.has_answered(prompt uuid, who uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT who = (SELECT auth.uid()) AND EXISTS (
    SELECT 1 FROM public.sealed_answers a
    WHERE a.prompt_id = prompt AND a.user_id = who
  );
$$;

NOTIFY pgrst, 'reload schema';
