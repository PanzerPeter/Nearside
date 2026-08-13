/*
  Nearside — forwarded messages
  Run once in the Supabase SQL editor after 0017. Re-runnable.

  What this is:
    One boolean on `public.messages`, set by the client when a message is
    created by forwarding an existing one rather than by typing it. It exists so
    the receiving bubble can say "Forwarded" — without it, something passed
    along from a third conversation is indistinguishable from something the
    sender wrote themselves.

    Deliberately just a flag, not a pointer to the original. A
    `forwarded_from_id` would name a message in a conversation the new recipient
    is not part of (and RLS would refuse to resolve it anyway), and a
    `forwarded_from_user` would tell the recipient who the sender was talking to
    — a disclosure neither of those two people agreed to. The flag says how the
    message got here and nothing about where it came from.

  Shape:
    NOT NULL DEFAULT false, so every existing row is correct without a backfill
    and every insert that doesn't mention the column keeps working — which is
    what lets the outbox's own insert (see ChatRoom.attemptSend) stay as it is.

  Security notes:
    - No policy changes. Forwarding is an ordinary INSERT: messages_insert_sender
      (0017) still pins user_id to auth.uid() and still requires the receiver to
      be an accepted friend or yourself, so a forward can no more reach a
      stranger than a typed message can.
    - The flag joins user_id and receiver_id as immutable (section 2). It is a
      claim about the message's provenance, and provenance that can be edited
      afterwards is not provenance: without this, an UPDATE could quietly drop
      the tag off a message that was forwarded, or paint it onto one that was
      not. No legitimate write touches the column after insert — edit, soft
      delete and the media trim all leave it alone.
*/

-- ============================================================
-- 1. The column
-- ============================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS forwarded boolean NOT NULL DEFAULT false;

-- ============================================================
-- 2. Freeze it, alongside the participants
-- ============================================================
-- Replaces the 0005 body, keeping its two checks verbatim and adding a third.
-- The trigger itself is left in place: only the function changes, so nothing
-- here depends on the trigger being re-created.
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
  IF NEW.forwarded IS DISTINCT FROM OLD.forwarded THEN
    RAISE EXCEPTION 'messages.forwarded is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.messages_prevent_reassign()
  FROM public, anon, authenticated;

-- Re-created only if it is missing, so a database that never ran 0005 (or had
-- the trigger dropped) still ends up guarded.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.messages'::regclass
      AND tgname = 'messages_prevent_reassign'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER messages_prevent_reassign
      BEFORE UPDATE ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.messages_prevent_reassign();
  END IF;
END;
$$;

-- ============================================================
-- 3. Schema cache
-- ============================================================
-- PostgREST rejects an insert naming a column it has not seen yet with
-- PGRST204, so the client cannot forward until this lands.
NOTIFY pgrst, 'reload schema';
