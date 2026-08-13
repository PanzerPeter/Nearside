/*
  Nearside — schema fingerprint

  Prints a normalized, fully ordered description of everything in `public`
  (plus the parts of `storage` this project owns). `db:verify` runs it against
  two databases — one built by replaying migrations/, one built from
  schema.sql — and diffs the two outputs.

  Why a catalog report rather than `pg_dump | diff`:
    pg_dump orders parts of its output by OID, which is creation order. The
    migrations create `chat_backgrounds` twice, rebuild `conversation_list()`
    five times and drop columns that schema.sql never creates, so the two
    databases reach the same shape by different routes and pg_dump prints them
    in different orders. Every one of those would read as a difference. This
    file sorts by name instead, so the only thing that can differ is the schema
    itself.

  What is deliberately compared:
    Grants and RLS policies, not just tables. In this schema the REVOKEs are
    load-bearing security — `theme_grants` is protected by a missing privilege
    as much as by a missing policy — so a fingerprint that ignored ACLs would
    pass a baseline that quietly opened the till.
*/

\pset tuples_only on
\pset format unaligned
\pset footer off

-- Extensions, wherever they were installed. 0010 and 0014 put pg_trgm and
-- pg_net in `public`; the platform provides the rest.
SELECT '## extension ' || e.extname || ' @ ' || n.nspname
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname NOT IN ('plpgsql')
 ORDER BY 1;

-- Tables, with RLS state and replica identity. REPLICA IDENTITY FULL is not
-- cosmetic here: without it realtime cannot evaluate the SELECT policy against
-- the OLD row, and a DELETE never reaches the peer.
SELECT '## table ' || c.relname
       || ' rls=' || c.relrowsecurity::text
       || ' forced=' || c.relforcerowsecurity::text
       || ' replident=' || c.relreplident::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY 1;

SELECT '## column ' || c.relname || '.' || a.attname
       || ' ' || format_type(a.atttypid, a.atttypmod)
       || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
       || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY 1;

-- Constraint definitions carry the CHECK expressions the app's guarantees rest
-- on: has_body, sealed_pair, media_key_pair, timers_normalized.
SELECT '## constraint ' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY 1;

SELECT '## index ' || pg_get_indexdef(i.indexrelid)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
 ORDER BY 1;

-- Policies for both schemas: storage.objects is where the media perimeter is.
SELECT '## policy ' || schemaname || '.' || tablename || '.' || policyname
       || ' ' || permissive
       || ' cmd=' || cmd
       || ' roles=' || array_to_string(roles, ',')
       || ' using=' || coalesce(qual, '-')
       || ' check=' || coalesce(with_check, '-')
  FROM pg_policies
 WHERE schemaname IN ('public', 'storage')
 ORDER BY 1;

-- Function bodies included: a policy is only as good as the SECURITY DEFINER
-- function it delegates to, and `SET search_path` is part of that.
SELECT '## function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
       || ' returns=' || pg_get_function_result(p.oid)
       || ' lang=' || l.lanname
       || ' volatile=' || p.provolatile::text
       || ' definer=' || p.prosecdef::text
       || ' config=' || coalesce(array_to_string(p.proconfig, ','), '-')
       || ' body=' || md5(p.prosrc)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
 WHERE n.nspname = 'public'
 ORDER BY 1;

SELECT '## trigger ' || pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('public', 'auth') AND NOT t.tgisinternal
 ORDER BY 1;

-- Table privileges for the two client roles. RLS decides which rows; this
-- decides whether the role can reach the table at all.
SELECT '## table-grant ' || t.relname || ' ' || r.rolname || ' ' || t.priv
  FROM (
    SELECT c.relname, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS priv
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) t
  CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) r
 WHERE has_table_privilege(r.rolname, 'public.' || quote_ident(t.relname), t.priv)
 ORDER BY 1;

-- EXECUTE grants. Every trigger function in this schema is revoked from the
-- client roles on purpose; PostgREST exposes anything left executable at
-- /rest/v1/rpc/<name>.
SELECT '## function-grant ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || r.rolname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated']) AS rolname) r
 WHERE n.nspname = 'public'
   AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
 ORDER BY 1;

SELECT '## realtime ' || tablename
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
 ORDER BY 1;

-- Bucket configuration is data, not DDL, so a schema dump would miss it — and
-- it is exactly where 0025 and storage/setup.sql are able to contradict each
-- other.
SELECT '## bucket ' || id
       || ' public=' || public::text
       || ' limit=' || coalesce(file_size_limit::text, '-')
       || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), '-')
  FROM storage.buckets
 ORDER BY 1;
