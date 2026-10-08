/*
  Nearside — names, bios and pictures are sealed

  Applied after 0060. Four columns on `profiles` and `display_name` made
  nullable, one table (`profile_keys`) with its policies, one helper function,
  `handle_new_user()` replaced, and `application/octet-stream` added to the
  avatars bucket.

  Until now a profile was the one thing about a person the server could read
  in full: the name they go by, the line they wrote about themselves, and their
  face, served from a public bucket to anyone holding the URL. The name also
  rode out to OneSignal in every notification. None of it is needed by the
  server — it only ever stored it and handed it back.

  Each account now has a profile key: 32 random bytes, kept on the server
  sealed under the owner's own vault key (so any device holding the twelve
  words recovers it), and used to seal one blob holding the name, the bio and
  the picture's file key. The picture itself is sealed with that file key and
  uploaded as opaque bytes — hence the new MIME type on the bucket.

  The profile key reaches the people who should see the profile through
  `profile_keys`: one row per reader, the key sealed with crypto_box from the
  owner to that reader's published key. Readers are exactly the people
  `profiles_select_connected` already lets read the row — anyone you have a
  friendship row with, pending included, so a request can still say who sent
  it. When somebody stops being one of those, the owner's app rotates the key:
  a new key, the profile resealed, every remaining reader granted again. The
  old grant opens nothing current.

  What the server keeps: that an account exists, its public keys, when it was
  last seen (and not even that with Online status off), and who holds whose
  profile key — which is the friendship graph it already had.

  Old rows: a profile keeps its plaintext columns until its owner's updated
  app seals it and clears them. Signup no longer sends the name to the auth
  service at all, so `handle_new_user()` leaves `display_name` null rather than
  inventing one from the email address — which was itself a plaintext name.
*/

ALTER TABLE public.profiles
  ALTER COLUMN display_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS profile_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS profile_key_nonce text,
  ADD COLUMN IF NOT EXISTS profile_ciphertext text,
  ADD COLUMN IF NOT EXISTS profile_nonce text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profile_key_pair;
ALTER TABLE public.profiles ADD CONSTRAINT profile_key_pair
  CHECK ((profile_key_ciphertext IS NULL) = (profile_key_nonce IS NULL));
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profile_sealed_pair;
ALTER TABLE public.profiles ADD CONSTRAINT profile_sealed_pair
  CHECK ((profile_ciphertext IS NULL) = (profile_nonce IS NULL));
-- A name, two hundred characters of bio and a file key, sealed, with room.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profile_sealed_length;
ALTER TABLE public.profiles ADD CONSTRAINT profile_sealed_length
  CHECK ((profile_ciphertext IS NULL OR char_length(profile_ciphertext) <= 4096)
         AND (profile_key_ciphertext IS NULL OR char_length(profile_key_ciphertext) <= 256));

/*
  Whether `a` and `b` have a friendship row in either direction, at any
  status. The same test `profiles_select_connected` makes, as a function so the
  grant policy below can ask it about somebody other than the caller.
*/
CREATE OR REPLACE FUNCTION public.has_friendship(a uuid, b uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships f
     WHERE (f.requester_id = a AND f.addressee_id = b)
        OR (f.requester_id = b AND f.addressee_id = a)
  );
$$;

REVOKE ALL ON FUNCTION public.has_friendship(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_friendship(uuid, uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.profile_keys (
  owner_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reader_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  key_ciphertext text NOT NULL,
  key_nonce      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, reader_id),
  CONSTRAINT profile_keys_not_self CHECK (owner_id <> reader_id),
  CONSTRAINT profile_keys_length CHECK (char_length(key_ciphertext) <= 256)
);

-- The reader's side of the primary key, for "every key granted to me".
CREATE INDEX IF NOT EXISTS profile_keys_reader_idx ON public.profile_keys (reader_id);

ALTER TABLE public.profile_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profile_keys_select_party ON public.profile_keys;
CREATE POLICY profile_keys_select_party ON public.profile_keys
  FOR SELECT TO authenticated
  USING ((select auth.uid()) IN (owner_id, reader_id));

-- Only to somebody who can already read the row the key opens: a grant to a
-- stranger would be a profile handed to someone the server would not show it to.
DROP POLICY IF EXISTS profile_keys_insert_owner ON public.profile_keys;
CREATE POLICY profile_keys_insert_owner ON public.profile_keys
  FOR INSERT TO authenticated
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND public.has_friendship(owner_id, reader_id)
  );

-- Upserted on rotation: the same reader, a new key.
DROP POLICY IF EXISTS profile_keys_update_owner ON public.profile_keys;
CREATE POLICY profile_keys_update_owner ON public.profile_keys
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = owner_id)
  WITH CHECK (
    (select auth.uid()) = owner_id
    AND public.has_friendship(owner_id, reader_id)
  );

DROP POLICY IF EXISTS profile_keys_delete_owner ON public.profile_keys;
CREATE POLICY profile_keys_delete_owner ON public.profile_keys
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = owner_id);

REVOKE ALL ON public.profile_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_keys TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  proposed text;
BEGIN
  -- Only an app from before 0061 sends a name at signup. The email address is
  -- no longer mined for one: the local part of an address is a name too, and
  -- the server is not to hold one.
  proposed := coalesce(
    NEW.raw_user_meta_data->>'display_name',
    NEW.raw_user_meta_data->>'username',
    ''
  );
  proposed := btrim(left(btrim(regexp_replace(proposed, '[[:cntrl:]]+', ' ', 'g')), 32));

  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, nullif(proposed, ''));
  RETURN NEW;
END;
$$;

UPDATE storage.buckets
   SET allowed_mime_types =
         ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream']
 WHERE id = 'avatars';

-- A friend's name appears the moment their app grants the key, rather than on
-- the next refresh: the list listens for the grant landing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'profile_keys'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profile_keys;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
