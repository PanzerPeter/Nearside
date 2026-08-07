/*
  Nearside — transparency

  One function: the names of the tables in the `public` schema.

  Why the screen needs it:
    "What the server knows" describes each table and what it can read. A
    hard-coded description goes stale the moment a migration adds a table, and
    it goes stale silently — the screen would keep making a true-sounding claim
    about a database that had changed underneath it. Reading the real list lets
    the client compare, and render "there is a table here nobody has described"
    rather than a confident lie.

  Why an RPC rather than a view:
    information_schema is not exposed through PostgREST, and exposing it would
    hand out far more than table names. This returns names only.

  What it does not leak:
    Table names are not user data — every one of them is in this repository's
    migrations folder. Column contents, row counts and ownership are not
    returned; the row counts on the screen come from ordinary RLS-scoped
    queries the user could have run themselves.
*/

CREATE OR REPLACE FUNCTION public.public_table_names()
RETURNS TABLE (table_name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
   ORDER BY c.relname;
$$;

REVOKE ALL ON FUNCTION public.public_table_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_table_names() TO authenticated;
