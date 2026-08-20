/*
  Nearside — a line about yourself

  Applied after 0039. Adds `profiles.bio`: a short self-written note that the
  people you are connected to see when they open your profile.

  It is plaintext, and that is a decision rather than an oversight.

  A bio could be sealed, but only per reader: there is no key every friend of
  yours already holds, so it would mean one `crypto_box` of the text per
  friendship, re-sealed on every edit, written again whenever a friendship is
  accepted, and repaired whenever a peer rotates their key. That is a fanout
  table and three new failure modes, bought for a paragraph that sits beside a
  display name and an avatar the server reads anyway — the avatar being an
  object in a *public* bucket. Sealing the caption under the photograph while
  the photograph hangs in the window is not privacy, it is decoration.

  So it goes in the open, and `lib/server-view.ts` lists it in the readable
  columns of `profiles` on the transparency screen, where the honest half of
  the claim lives.

  No control-character CHECK, unlike `display_name`. A display name is rendered
  inline in the sidebar and the chat header, where a newline breaks the line for
  everybody who ever connected with the person who chose it; a bio is rendered
  in a block of its own on one screen, and paragraphs are the point of it. The
  length cap is 200 — enough for a sentence or three, short enough that no
  profile card scrolls.

  Nullable, with no default: an account that has never written one holds NULL,
  not an empty string, so "has said nothing" and "said nothing" cannot be told
  apart by the schema and do not need to be. The CHECK forbids a blank string
  reaching the column, which is what keeps that true — the client sends NULL
  when the field is cleared.

  No new policy. RLS is per row: `profiles_select_connected` already decides who
  reads a profile row (you, and anyone you have a friendship with), and
  `profiles_update_own` already decides who writes one. A column added to a
  table under RLS inherits both, which is why adding a second policy here would
  grant nothing and add a place a future narrowing has to be remembered.
*/

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bio text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS bio_length;

ALTER TABLE public.profiles
  ADD CONSTRAINT bio_length
  CHECK (bio IS NULL OR char_length(btrim(bio)) BETWEEN 1 AND 200);
