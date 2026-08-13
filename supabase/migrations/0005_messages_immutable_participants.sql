/*
  Nearside — lock message participants on UPDATE
  Run once in the Supabase SQL editor after 0004.

  Why:
    The messages INSERT policy (0001) enforces that a sender may only create a
    message to an *accepted friend*. The UPDATE policy, however, only checks
    `auth.uid() = user_id` in its WITH CHECK — and an RLS policy cannot compare
    the NEW row against the OLD one. That let a sender edit an existing message
    and repoint `receiver_id` at an arbitrary user, delivering an unsolicited DM
    that bypasses the friendship gate entirely (spam / harassment vector).

  Fix:
    A BEFORE UPDATE trigger makes `user_id` and `receiver_id` immutable. Every
    legitimate update (edit content, soft-delete, media trim) leaves both
    columns unchanged, so this is transparent to the app while closing the gate.
*/

CREATE OR REPLACE FUNCTION public.messages_prevent_reassign()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.receiver_id IS DISTINCT FROM OLD.receiver_id THEN
    RAISE EXCEPTION 'messages.user_id and messages.receiver_id are immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.messages_prevent_reassign()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS messages_prevent_reassign ON public.messages;
CREATE TRIGGER messages_prevent_reassign
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_prevent_reassign();
