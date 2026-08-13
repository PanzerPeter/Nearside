/*
  Nearside — Supabase platform shim for a bare Postgres container

  The migrations in this repo are written against a Supabase project, so they
  assume a platform that a stock `postgres:17` image does not have: an `auth`
  schema holding the users table, a `storage` schema holding buckets and
  objects, the `anon` / `authenticated` / `service_role` grantees, pgcrypto in
  the `extensions` schema, and a `supabase_realtime` publication to add tables
  to.

  This file creates just enough of that for the DDL to apply and for the
  resulting schema to be comparable. It is NOT a Supabase emulator: the bodies
  here are stubs, nothing enforces a JWT, and no row-level behaviour is
  exercised. It exists so `db:verify` can answer one question — do the 30
  migrations and schema.sql describe the same database? — without a network,
  an account, or a risk of touching production.

  Everything it creates lives outside `public`, so it never appears in the
  dump the comparison runs on.
*/

-- ---------------------------------------------------------------------------
-- Roles. Supabase ships these; the migrations REVOKE and GRANT against them by
-- name, and a missing role is a hard error rather than a no-op.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END;
$$;

-- Supabase's historical default: every new table in `public` is granted to the
-- client roles, and RLS is what actually scopes it. Several migrations rely on
-- that default being in force so their explicit REVOKE means something.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- extensions schema. 0022b calls extensions.gen_random_bytes() explicitly,
-- schema-qualified, because it runs under SET search_path = ''.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth. Only the columns the migrations actually read: 0001/0019/0022 read
-- raw_user_meta_data from the signup trigger, 0030 looks an account up by
-- email, and several tables carry a foreign key to auth.users(id).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Reads a session GUC instead of a JWT. Returning NULL is the honest answer
-- here: no policy in this container is being evaluated against a real caller.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage. 0025 updates a bucket's mime whitelist, 0029's sweep deletes from
-- storage.objects, and storage/setup.sql creates both buckets and their
-- policies on storage.objects.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  public             boolean NOT NULL DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name      text,
  owner     uuid,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Splits an object key into path segments. The real one behaves the same way
-- for the `{uid}/file` and `{uidA}_{uidB}/file` conventions the policies use.
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT string_to_array(name, '/');
$$;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- pg_net. Not installable here, and 0014's trigger is the only caller. The
-- replay strips its CREATE EXTENSION line (see verify.sh) and uses this stub,
-- so notify_push_on_message() compiles and the trigger can be created.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS net;

CREATE OR REPLACE FUNCTION net.http_post(
  url                  text,
  body                 jsonb DEFAULT '{}'::jsonb,
  params               jsonb DEFAULT '{}'::jsonb,
  headers              jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE sql
AS $$ SELECT 0::bigint; $$;

-- ---------------------------------------------------------------------------
-- Realtime publication. Several migrations add tables to it, each guarded by a
-- pg_publication_tables check that needs the publication to exist to be false.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END;
$$;
