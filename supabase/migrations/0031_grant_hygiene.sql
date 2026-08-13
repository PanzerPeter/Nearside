/*
  Nearside — grant hygiene

  Applied after 0030. Two corrections, both found by replaying every migration
  in this folder into a throwaway Postgres and reading the resulting catalog
  (see supabase/verify/). Neither is reachable from the app, and re-running the
  file is safe.

  1. conversation_list() is executable by `anon`.

     0022 created it with the REVOKE that every other RPC here carries. 0023
     then rebuilt it — DROP FUNCTION, because removing last_message changes the
     return type — and the new function was created without one. A function
     created in `public` is EXECUTE-able by PUBLIC by default, so the drop
     silently handed the RPC back to anonymous callers.

     Not a disclosure: with no JWT, auth.uid() is NULL, `peers` is empty, the
     self-chat row is NULL, and the join to profiles matches nothing — an
     anonymous call returns zero rows. This closes an unintended endpoint at
     /rest/v1/rpc/conversation_list, which is the same class of surface
     reduction 0019a did for the trigger functions.

  2. chat_backgrounds' primary key is called chat_backgrounds_pkey1.

     0013 replaced the pair-shaped table from 0012 by renaming it aside and
     creating the new one beside it. The old table still owned the name
     chat_backgrounds_pkey at that moment, so Postgres uniquified the new
     constraint. The old table was dropped later in the same file and the name
     freed, but the suffix stayed.

     Cosmetic, and it is the one place where a database built from schema.sql
     would legitimately differ from one built by replaying this folder. Renamed
     so the two agree, and so `db:verify` needs no exception to pass.
*/

REVOKE ALL ON FUNCTION public.conversation_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conversation_list() TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chat_backgrounds'::regclass
       AND conname = 'chat_backgrounds_pkey1'
  ) THEN
    ALTER TABLE public.chat_backgrounds
      RENAME CONSTRAINT chat_backgrounds_pkey1 TO chat_backgrounds_pkey;
  END IF;
END;
$$;
