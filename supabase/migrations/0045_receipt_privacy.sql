/*
  Nearside — read receipts become a choice, and the choice is the server's rule

  Applied after 0044. One table, one definer function, and one replaced SELECT
  policy on `message_receipts`.

  Why it exists. "Seen" is the one thing this app told your peer about you that
  you never agreed to and could not switch off. Everything else it shares is
  something you did: a message, a reaction, a call. A read watermark is
  something your *phone* did — it says when the screen was on and pointing at
  their conversation.

  Why it is not a client-side check. The row is readable by the peer, so a
  client that simply declined to render the tick would be hiding a fact the
  other device already holds — one `curl` and a public repository away from
  being read anyway. This is the same rule `sealed_answers` follows: if the
  product claims the other side cannot see something, the database has to be
  what stops them.

  Why not a column on `message_receipts`. The watermark row is written on every
  glance at a conversation, and folding a preference into that hot upsert makes
  a client running against an un-migrated database fail to advance its own
  watermark at all — which breaks *its* unread counts, not the peer's ticks.
  A separate one-row-per-account table is written when the setting changes and
  never otherwise, so an old client keeps working and a new client against an
  old database fails only at the toggle.

  What it does not change. Nothing about `read_at` itself, and nothing about
  what the account's own device can read: `unread_counts()` and the "new
  messages" line both read the account's own row, which stays visible to it. A
  peer whose access is withdrawn loses the *whole* row, delivery included —
  hiding "read" while still reporting "delivered on their phone at 03:12" is
  not a privacy setting, it is a smaller leak.

  The function is SECURITY DEFINER for the reason `has_answered()` is: the
  policy has to ask about a row belonging to somebody else, and a policy that
  reads a table the caller cannot read returns nothing rather than the truth.
*/

CREATE TABLE IF NOT EXISTS public.receipt_prefs (
  user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  share_read boolean NOT NULL DEFAULT true
);

ALTER TABLE public.receipt_prefs ENABLE ROW LEVEL SECURITY;

-- Own row only, in both directions. Nobody reads anybody else's preference
-- directly; the policy below needs the answer, not the row.
DROP POLICY IF EXISTS "receipt_prefs_select_own" ON public.receipt_prefs;
CREATE POLICY "receipt_prefs_select_own" ON public.receipt_prefs
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipt_prefs_insert_own" ON public.receipt_prefs;
CREATE POLICY "receipt_prefs_insert_own" ON public.receipt_prefs
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipt_prefs_update_own" ON public.receipt_prefs;
CREATE POLICY "receipt_prefs_update_own" ON public.receipt_prefs
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "receipt_prefs_delete_own" ON public.receipt_prefs;
CREATE POLICY "receipt_prefs_delete_own" ON public.receipt_prefs
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

REVOKE ALL ON TABLE public.receipt_prefs FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.receipt_prefs TO authenticated;

/*
  Whether `uid` lets the people they talk to see their watermarks. No row means
  yes: every account that existed before this migration shared them, and a
  default that silently turned the feature off for everybody would be a change
  nobody asked for.
*/
CREATE OR REPLACE FUNCTION public.shares_read(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT p.share_read FROM public.receipt_prefs p WHERE p.user_id = uid),
    true
  );
$$;

REVOKE ALL ON FUNCTION public.shares_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shares_read(uuid) TO authenticated;

-- The peer's half of the old policy, now conditional. The owner's half is
-- unchanged and unconditional: an account can always read its own watermarks,
-- which is what its unread counts and its "new messages" line are built on.
DROP POLICY IF EXISTS "receipts_select_participant" ON public.message_receipts;
CREATE POLICY "receipts_select_participant" ON public.message_receipts
  FOR SELECT TO authenticated
  USING (
    (select auth.uid()) = user_id
    OR ((select auth.uid()) = peer_id AND public.shares_read(user_id))
  );
