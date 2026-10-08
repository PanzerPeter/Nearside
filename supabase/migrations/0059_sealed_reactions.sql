/*
  Nearside — reactions are sealed

  Applied after 0058. Two columns on each reaction table, `emoji` made
  nullable, and two constraints on each.

  The emoji used to be plaintext, on the argument that a single character
  carries too little to seal. It carries the part of a conversation that is
  nothing but content — a heart and a vomiting face under the same photo are
  different answers — and the server could read every one. New rows carry it
  sealed the way a body is: to the peer in a 1:1 conversation, under the vault
  key in the self-chat, under the room key in a group. The server keeps who
  reacted to which message, and when; it no longer keeps what with.

  Rows written before this stay plaintext and keep rendering. There is
  nothing to backfill and nothing that could: the server cannot seal on
  anybody's behalf, which is the point.

  The UNIQUE (message_id, user_id, emoji) stays for those rows. Sealed rows
  have a null `emoji` and a fresh nonce each, so it does not dedupe them; the
  client checks its own reactions before adding one, as it always has, and
  the rate limit still bounds a loop.
*/

ALTER TABLE public.message_reactions
  ALTER COLUMN emoji DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS emoji_ciphertext text,
  ADD COLUMN IF NOT EXISTS emoji_nonce text;

ALTER TABLE public.message_reactions DROP CONSTRAINT IF EXISTS reaction_sealed_pair;
ALTER TABLE public.message_reactions ADD CONSTRAINT reaction_sealed_pair
  CHECK ((emoji_ciphertext IS NULL) = (emoji_nonce IS NULL));
ALTER TABLE public.message_reactions DROP CONSTRAINT IF EXISTS reaction_has_emoji;
ALTER TABLE public.message_reactions ADD CONSTRAINT reaction_has_emoji
  CHECK (emoji IS NOT NULL OR (emoji_ciphertext IS NOT NULL
                               AND char_length(emoji_ciphertext) <= 256));

ALTER TABLE public.room_message_reactions
  ALTER COLUMN emoji DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS emoji_ciphertext text,
  ADD COLUMN IF NOT EXISTS emoji_nonce text;

ALTER TABLE public.room_message_reactions DROP CONSTRAINT IF EXISTS room_reaction_sealed_pair;
ALTER TABLE public.room_message_reactions ADD CONSTRAINT room_reaction_sealed_pair
  CHECK ((emoji_ciphertext IS NULL) = (emoji_nonce IS NULL));
ALTER TABLE public.room_message_reactions DROP CONSTRAINT IF EXISTS room_reaction_has_emoji;
ALTER TABLE public.room_message_reactions ADD CONSTRAINT room_reaction_has_emoji
  CHECK (emoji IS NOT NULL OR (emoji_ciphertext IS NOT NULL
                               AND char_length(emoji_ciphertext) <= 256));
