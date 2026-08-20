/*
  Nearside — the name you gave someone stops being readable

  Applied after 0040. Seals `friend_nicknames.nickname` under the owner's vault
  key, which is the same treatment `stickers.label_ciphertext` got in 0033 and
  for the same reason.

  A nickname is the most private thing in this schema that was still plaintext.
  0016 built it as a label visible only to you — the person it names is never
  told, by design — and then wrote it into a column any database credential
  could read. "Visible only to you" was true of the app and false of the
  server, and this app's whole claim is that those two are the same sentence.

  It is also the cheapest thing here to seal. The row is owner-only: the SELECT
  policy has never let anybody but its author read it, so there is no second
  party to seal to and no key to distribute. The vault key — already derived
  from the seed in the Keystore, already used for the self-chat, for stickers
  and for chat backgrounds — is the whole mechanism.

  Backwards compatible, deliberately, and this is the part to read before
  changing anything:

    `nickname` becomes nullable and keeps its CHECKs, now written to pass a
    NULL explicitly rather than by the accident that a CHECK on NULL is not
    false. Existing rows still hold their plaintext and still render, because
    the client falls back to the column when there is no ciphertext.

    The client re-seals those rows as it finds them and clears the plaintext in
    the same write, so a device migrates its own nicknames the first time it
    loads them. Nothing is lost, and nothing waits for a user to notice a
    setting.

    `nickname_plaintext_or_sealed` is what keeps the two representations from
    both going missing: a row must carry one or the other. A row with neither
    is a name that is nothing, rendering as a blank line in the sidebar.

  Dropping the `nickname` column is a LATER migration, not this one. It can go
  once no rows with a non-null `nickname` are left:

    SELECT count(*) FROM public.friend_nicknames WHERE nickname IS NOT NULL;

  Run that before writing it. Dropping while rows remain deletes nicknames that
  belong to people whose devices have not opened the app since this migration —
  which is data loss disguised as tidying up.
*/

ALTER TABLE public.friend_nicknames
  ADD COLUMN IF NOT EXISTS nickname_ciphertext text,
  ADD COLUMN IF NOT EXISTS nickname_nonce      text;

ALTER TABLE public.friend_nicknames
  ALTER COLUMN nickname DROP NOT NULL;

-- Rewritten to name the NULL case. Unchanged in effect: a CHECK evaluating to
-- NULL already passed. Stated so the next reader does not have to know that.
ALTER TABLE public.friend_nicknames
  DROP CONSTRAINT IF EXISTS nickname_length;
ALTER TABLE public.friend_nicknames
  ADD CONSTRAINT nickname_length
  CHECK (nickname IS NULL OR char_length(btrim(nickname)) BETWEEN 1 AND 32);

ALTER TABLE public.friend_nicknames
  DROP CONSTRAINT IF EXISTS nickname_single_line;
ALTER TABLE public.friend_nicknames
  ADD CONSTRAINT nickname_single_line
  CHECK (nickname IS NULL OR nickname ~ '^[^[:cntrl:]]+$');

-- Both halves of the seal or neither, the rule every sealed pair in this schema
-- follows (`chat_backgrounds_key_complete`, 0039). A ciphertext without its
-- nonce is a name that can never be opened again.
ALTER TABLE public.friend_nicknames
  DROP CONSTRAINT IF EXISTS nickname_seal_complete;
ALTER TABLE public.friend_nicknames
  ADD CONSTRAINT nickname_seal_complete
  CHECK (num_nonnulls(nickname_ciphertext, nickname_nonce) IN (0, 2));

-- And at least one of the two ways of holding the name.
ALTER TABLE public.friend_nicknames
  DROP CONSTRAINT IF EXISTS nickname_plaintext_or_sealed;
ALTER TABLE public.friend_nicknames
  ADD CONSTRAINT nickname_plaintext_or_sealed
  CHECK (nickname IS NOT NULL OR nickname_ciphertext IS NOT NULL);
