/*
  Nearside — encrypted message bodies

  Contents:
    1. messages.ciphertext / messages.nonce — base64 secretbox or box output
    2. has_body widened so a sealed body counts as a body
    3. ciphertext and nonce constrained to travel together

  Why has_body must change:
    0001 declared CHECK (content IS NOT NULL OR media_path IS NOT NULL).
    A sealed text message has content NULL and media_path NULL, so every vault
    insert would be rejected by the constraint before RLS ever saw it. content
    is ALREADY nullable in 0001 — the missing piece was never the NOT NULL, it
    was this check.

  Why content is not dropped yet:
    Plan 2 encrypts the self-chat only, because peer encryption needs the
    published keys from 0020 AND the verified-connect flow that does not exist
    until Plan 3. Dropping content here would break every existing
    conversation with no replacement. Plan 3's 0022 drops it, along with the
    trigram index and search_messages(), once every body is sealed.

  Security notes:
    - No key material is stored here. ciphertext is opaque to the database and
      to anyone holding a database credential.
    - The authentication tag is inside ciphertext; a row edited in the
      database fails to open on the device rather than decrypting to something
      chosen by whoever edited it.
    - Widening has_body does not weaken it: a row still cannot be empty, it
      just has a third way of carrying something.
*/

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS ciphertext text,
  ADD COLUMN IF NOT EXISTS nonce      text;

-- A body may now be plaintext, media, or a sealed blob — but not nothing.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS has_body;
ALTER TABLE public.messages ADD CONSTRAINT has_body
  CHECK (content IS NOT NULL OR media_path IS NOT NULL OR ciphertext IS NOT NULL);

-- Same shape as 0001's media_pair: half a sealed body is a bug, not a state.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS sealed_pair;
ALTER TABLE public.messages ADD CONSTRAINT sealed_pair
  CHECK ((ciphertext IS NULL) = (nonce IS NULL));
