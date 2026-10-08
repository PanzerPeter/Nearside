/*
  Nearside — a group's name is sealed under its room key

  Applied after 0059. Two columns on `rooms`, `title` made nullable, three
  constraints, `rooms_for_me()` replaced (its result gains two columns, which
  CREATE OR REPLACE cannot do, so it is dropped first), `set_room_title()`
  replaced, and two functions added.

  The group picture has been sealed since it existed; the name beside it was
  not. It sat in `rooms.title` for the server to read, and `send-push` handed
  it to OneSignal as the heading of every notification — so a third party saw
  "Mum's 60th, surprise" next to each sender. A name is now sealed under the
  room key, which every member already holds, exactly as the picture's file key
  is. The notification heading falls back to "a group".

  Existing groups keep their plaintext name until a member's updated app opens
  the group list, which reseals it through `seal_room_title()`. That function
  only replaces a name that is still plaintext and does not stamp
  `title_set_by`/`title_set_at`, so a reseal is not shown as a rename. The
  server cannot check that the sealed name is the same one — it cannot read it,
  which is the point — but a member could rename the group anyway, with a line
  in the thread saying so; the reseal path only spares them the line, once.

  An app from before this file still calls `set_room_title()`, which now also
  clears the sealed columns, so the newest name wins whichever app wrote it.
*/

ALTER TABLE public.rooms
  ALTER COLUMN title DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS title_ciphertext text,
  ADD COLUMN IF NOT EXISTS title_nonce text;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_title_sealed_pair;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_title_sealed_pair
  CHECK ((title_ciphertext IS NULL) = (title_nonce IS NULL));
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_title_present;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_title_present
  CHECK (title IS NOT NULL OR title_ciphertext IS NOT NULL);
-- Sixty characters of name, sealed and base64'd, with room to spare.
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_title_ciphertext_length;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_title_ciphertext_length
  CHECK (title_ciphertext IS NULL OR char_length(title_ciphertext) <= 512);

CREATE OR REPLACE FUNCTION public.set_room_title(target uuid, new_title text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := auth.uid();
  cleaned text := btrim(coalesce(new_title, ''));
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  -- Drawn on one line in the list, the header and every notification.
  IF cleaned ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'a group name is one line';
  END IF;

  UPDATE public.rooms
     SET title            = cleaned,
         title_ciphertext = NULL,
         title_nonce      = NULL,
         title_set_by     = me,
         title_set_at     = now()
   WHERE id = target;
END;
$$;

/*
  A rename, sealed. The same rule as the plaintext one — any member — and the
  same record of who and when. Length and line breaks are the client's to
  check now: the server holds ciphertext and can only bound its size.
*/
CREATE OR REPLACE FUNCTION public.set_room_title_sealed(target uuid, ciphertext text, nonce text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid := auth.uid();
BEGIN
  IF me IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  IF ciphertext IS NULL OR nonce IS NULL THEN
    RAISE EXCEPTION 'a sealed name needs both halves';
  END IF;

  UPDATE public.rooms
     SET title            = NULL,
         title_ciphertext = ciphertext,
         title_nonce      = nonce,
         title_set_by     = me,
         title_set_at     = now()
   WHERE id = target;
END;
$$;

/* The one-time reseal of a name written before this file. See the header. */
CREATE OR REPLACE FUNCTION public.seal_room_title(target uuid, ciphertext text, nonce text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_room_member(target) THEN
    RAISE EXCEPTION 'not a member of that room';
  END IF;
  IF ciphertext IS NULL OR nonce IS NULL THEN
    RAISE EXCEPTION 'a sealed name needs both halves';
  END IF;

  UPDATE public.rooms
     SET title            = NULL,
         title_ciphertext = ciphertext,
         title_nonce      = nonce
   WHERE id = target AND title IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.set_room_title_sealed(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_title_sealed(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.seal_room_title(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seal_room_title(uuid, text, text) TO authenticated;

DROP FUNCTION IF EXISTS public.rooms_for_me();
CREATE FUNCTION public.rooms_for_me()
RETURNS TABLE (
  id               uuid,
  title            text,
  title_ciphertext text,
  title_nonce      text,
  created_by       uuid,
  created_at       timestamptz,
  member_count     bigint,
  last_at          timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT r.id,
         r.title,
         r.title_ciphertext,
         r.title_nonce,
         r.created_by,
         r.created_at,
         (SELECT count(*) FROM public.room_participants p WHERE p.room_id = r.id),
         (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id)
    FROM public.rooms r
   WHERE EXISTS (
           SELECT 1 FROM public.room_participants me
            WHERE me.room_id = r.id AND me.user_id = (SELECT auth.uid())
         )
   ORDER BY coalesce(
              (SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id),
              r.created_at
            ) DESC;
$$;

REVOKE ALL ON FUNCTION public.rooms_for_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rooms_for_me() TO authenticated;
