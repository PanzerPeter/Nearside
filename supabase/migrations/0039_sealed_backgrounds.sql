/*
  Nearside — chat backgrounds stop being the exception

  Applied after 0038. Seals the one image this app still uploaded in the clear.

  Everything else in `chat-media` is opaque: 0024 gave every attachment a random
  per-file key, 0025 made the bucket announce `application/octet-stream` and
  nothing else. Chat backgrounds (0012) were built before that and never caught
  up. They went up as a plain JPEG or PNG, with a real content type, into the
  conversation's own folder — which the storage policy opens to *both*
  participants, because it was written for attachments the two of them share.

  So the picture behind your thread was readable by the server, and listable and
  readable by the person you were talking to. `lib/background.ts` said as much
  in a comment. A background is often a photo of something personal, and "the
  server holds no bodies" is a claim the transparency screen makes out of live
  queries; one plaintext image in the bucket is one more than that claim allows.

  The fix is the one already in the codebase, not a new mechanism: a random
  per-file key from `lib/media-crypto.ts`, sealed under the owner's *vault* key
  rather than to a peer. The vault key is right here — a background is chosen by
  one person, stored on their own row, and never shown to anyone else, so there
  is no second party to seal to. That also means the peer's ability to read the
  object buys them nothing: it is ciphertext, and the key is on a row their RLS
  policy has never let them see.

  Both columns or neither. A path whose key is missing is an image that can
  never be opened, and it would be drawn as a broken picture forever — the same
  rule and the same reason as `rooms_avatar_complete` in 0026.

  Backwards compatible on purpose. Existing rows have null keys and keep
  rendering as plaintext, because they *are* plaintext and deleting somebody's
  wallpaper to make a schema tidy is not a fix. They are replaced the next time
  that person sets one. The bucket's `allowed_mime_types` therefore still
  carries the image types; it can narrow to `application/octet-stream` alone
  once no null-key rows are left.
*/

ALTER TABLE public.chat_backgrounds
  ADD COLUMN IF NOT EXISTS key_ciphertext text,
  ADD COLUMN IF NOT EXISTS key_nonce      text;

ALTER TABLE public.chat_backgrounds
  DROP CONSTRAINT IF EXISTS chat_backgrounds_key_complete;

ALTER TABLE public.chat_backgrounds
  ADD CONSTRAINT chat_backgrounds_key_complete
  CHECK (num_nonnulls(key_ciphertext, key_nonce) IN (0, 2));
