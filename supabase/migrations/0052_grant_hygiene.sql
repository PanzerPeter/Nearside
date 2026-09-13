/*
  Nearside — the privileges the core tables never got

  Applied after 0051. No table, no policy, no function, no behaviour change on
  a project that already works. It narrows the PRIVILEGES on the thirteen
  oldest tables to what their policies actually allow, which is what every
  table added since 0032 already does for itself.

  ---------------------------------------------------------------------------
  Why this is a second gate and not a duplicate of RLS.

  `schema.sql` §6 states the rule and 0031 applied it to part of the schema:

      Privileges are granted explicitly here rather than relying on Supabase's
      historical default of auto-granting every new public table to the client
      roles. That default is moving to opt-in, and a table created today can
      end up reachable by no client role at all — which surfaces as 42501
      "permission denied", not as an RLS denial.

  Everything from `sealed_answers` (0032) onward obeys it. The tables that
  predate it do not, so they still hold whatever `ALTER DEFAULT PRIVILEGES ...
  GRANT ALL ON TABLES TO anon, authenticated` handed them — which is ALL:
  SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER, to `anon`
  as well as `authenticated`, on `messages`, `profiles`, `room_keys` and ten
  others. RLS is the only thing holding all of that shut.

  It does hold it shut. Every policy on these tables is `TO authenticated`, so
  `anon` matches none of them and fails closed, and PostgREST issues no
  TRUNCATE. This is not a live hole and nothing here is a fix for one.

  It is the same argument the file already makes for `theme_grants` — "a policy
  added carelessly later should not be enough to open the till" — applied to
  the tables that hold the messages rather than the ones that hold the themes.
  Six theme packs get two gates; `room_keys` gets one.

  ---------------------------------------------------------------------------
  How each line below was chosen.

  One rule, no judgement: a table is granted exactly the verbs it has a policy
  for. That keeps the two gates describing the same thing, and it means a
  policy can never be quietly unreachable because the grant beneath it is
  narrower than it is.

  So `messages` gets SELECT, INSERT, UPDATE — its DELETE was already revoked by
  0034 and has no policy. `rooms`, `room_participants` and `room_keys` get no
  UPDATE, because none of them has an UPDATE policy: a room's title has never
  been changeable, and its picture and timer are written by
  `set_room_avatar()` and `set_room_timer()`, which run as the owner precisely
  so that "may set the picture" cannot also read as "may rewrite created_by".
  `conversation_timers` gets SELECT alone for the same reason — writes go
  through `set_conversation_timer()`, which is the only thing that can
  normalize the pair.

  `connect_tokens`, `message_pushes` and `push_config` get nothing at all.
  They have no policies by design: a client that could read `connect_tokens`
  could enumerate live connect codes, and `push_config.trigger_secret` is what
  authorizes the `--no-verify-jwt` path into `send-push` — the highest-value
  row in this database, and until now the only one of the four push tables
  whose siblings all carry an explicit REVOKE and it did not.

  Verified against the client before narrowing: nothing in `src/` updates
  `rooms`, `room_participants`, `room_keys`, `conversation_timers` or
  `message_reactions`, and nothing touches the three revoked tables at all.

  ---------------------------------------------------------------------------
  Replay safety. GRANT and REVOKE are idempotent, and every statement here is
  absolute rather than relative — REVOKE ALL then GRANT the intended set — so
  running this file twice leaves the same privileges as running it once.
*/

-- ------------------------------------------------------------------ identity

REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

REVOKE ALL ON public.friendships FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.friendships TO authenticated;

-- No policy, and no grant. Reachable only through `mint_connect_code()` and
-- `redeem_connect_code()`, which are SECURITY DEFINER and unaffected. A client
-- that could read this table could enumerate every live code.
REVOKE ALL ON public.connect_tokens FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------ messages

-- DELETE stays revoked (0034): removing a message is a tombstone, which is an
-- UPDATE. This restates the rest rather than widening anything.
REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;

-- Select, insert, delete. A reaction is added or taken back, never edited, and
-- there has never been an UPDATE policy for one.
REVOKE ALL ON public.message_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.message_reactions TO authenticated;

REVOKE ALL ON public.message_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_receipts TO authenticated;

-- --------------------------------------------------------------------- rooms

-- No UPDATE on any of the three: `rooms` has no UPDATE policy (the picture and
-- the timer go through definer functions that name the columns they write),
-- and neither participants nor sealed keys have ever been editable in place.
REVOKE ALL ON public.rooms FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.rooms TO authenticated;

REVOKE ALL ON public.room_participants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.room_participants TO authenticated;

REVOKE ALL ON public.room_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.room_keys TO authenticated;

-- DELETE stays revoked (0036), for the reason it is revoked on `messages`.
REVOKE ALL ON public.room_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.room_messages TO authenticated;

-- --------------------------------------------------------- disappearing, push

-- Read-only to the client. `set_conversation_timer()` is the only writer, and
-- the only thing that can normalize the pair the way `timers_normalized`
-- requires.
REVOKE ALL ON public.conversation_timers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_timers TO authenticated;

-- Server-side, both of them. `push_config` holds the secret that authorizes
-- the database's own call into `send-push`; its three sibling tables have
-- carried this REVOKE since 0035 and 0037 and these two never did.
REVOKE ALL ON public.message_pushes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.push_config    FROM PUBLIC, anon, authenticated;
