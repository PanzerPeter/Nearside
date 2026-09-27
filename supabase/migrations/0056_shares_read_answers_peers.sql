/*
  Nearside — shares_read() answers only the question its policy asks

  Applied after 0055. No new table, column, policy or grant: one function,
  replaced whole.

  `shares_read(uid)` exists for `receipts_select_participant`, which asks it
  about the owner of a watermark row addressed to the caller. But it is a
  SECURITY DEFINER function in `public`, granted to `authenticated`, and
  PostgREST exposes every such function at /rest/v1/rpc/<name>. So it was
  also an endpoint that told any signed-in account, for any account id,
  whether that person had switched read receipts off — a setting whose own
  table is readable only by its owner. 0055 closed the same hole in
  `has_answered()`.

  The fix is to answer only where the policy would: about someone who has a
  watermark row addressed to the caller, which exists only once they have
  received a message from them. Everyone else gets false, whatever their
  setting, so the answer carries nothing. A peer learns nothing new either:
  they could already tell by whether the row is visible to them.

  `(user_id, peer_id)` is the primary key of `message_receipts`, so the added
  check is one index probe per row the policy evaluates. It cannot recurse:
  a definer function reads the table with RLS off, as `has_answered()` does.

  verify/smoke.sql asks as a stranger about one account that hides receipts
  and one that does not, and checks that the two peers still see exactly
  what the setting says.
*/

CREATE OR REPLACE FUNCTION public.shares_read(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.message_receipts r
    WHERE r.user_id = uid AND r.peer_id = (SELECT auth.uid())
  ) AND coalesce(
    (SELECT p.share_read FROM public.receipt_prefs p WHERE p.user_id = uid),
    true
  );
$$;
