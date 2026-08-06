/*
  Nearside — encrypted media

  A random key per file. The file is sealed with it before upload, and the key
  itself is sealed to the recipient and stored on the message row. Storage
  holds bytes nobody with a storage credential can open.

  Why a per-file key rather than sealing the bytes to the recipient directly:
    crypto_box over a 50 MB video would mean holding the whole thing in memory
    twice and re-sealing it per recipient. A 32-byte key is cheap to seal, and
    the file is sealed once with a secretbox regardless of who receives it.

  The key columns are nullable because a text-only message has no media. They
  are NOT covered by has_body — a media key is not a body, and a row carrying
  one without a media_path would be a bug, not a message.
*/
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_key_ciphertext text,
  ADD COLUMN IF NOT EXISTS media_key_nonce      text;

/*
  Both or neither, for the same reason 0021 added sealed_pair to the body: a
  ciphertext without its nonce is unopenable, and storing half of a pair is a
  state no code path intends and every reader would have to defend against.
*/
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS media_key_pair;
ALTER TABLE public.messages ADD CONSTRAINT media_key_pair
  CHECK ((media_key_ciphertext IS NULL) = (media_key_nonce IS NULL));
