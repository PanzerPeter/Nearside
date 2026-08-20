/*
  Nearside — the transparency screen learns to check its own columns

  Applied after 0042. One function, the counterpart of `public_table_names()`
  from 0027: the columns of the tables in `public`.

  Why it exists. 0027 made the screen compare its list of described *tables*
  against the real ones, so a table added by a migration and never described
  shows a warning instead of being silently absent. It never did the same for
  columns, and columns are what the screen actually claims things about — every
  card says "server reads: …" and "sealed: …" from a hand-written list. That
  list had drifted by four tables and several columns before anybody read the
  schema again, and nothing in the app could have said so.

  With this the drift is visible in the app, in the same words the table
  warning uses. A column somebody adds without describing it turns the screen
  into "we are not sure", which is the honest failure, and the one a
  transparency page has to be capable of.

  What it does not leak. Column names, and only for `public`. No types, no
  defaults, no contents, no row counts. Every one of these names is in this
  repository's migrations folder already; what is not in the repository is the
  *live* database's shape, and knowing that this function reports it is the
  reason to trust the screen it feeds.

  Dropped columns are excluded (`attisdropped`), as are the system columns
  Postgres puts on every table (`attnum > 0`). Without both, the screen would
  report `ctid`, `xmin` and every column ever removed as things the server
  holds about you.
*/

CREATE OR REPLACE FUNCTION public.public_table_columns()
RETURNS TABLE (table_name text, column_name text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT c.relname::text, a.attname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum;
$$;

REVOKE ALL ON FUNCTION public.public_table_columns() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.public_table_columns() TO authenticated;
