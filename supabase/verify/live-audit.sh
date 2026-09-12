#!/usr/bin/env bash
#
# Nearside — compare the LIVE project against the schema this repo describes.
#
# `db:verify` answers "do migrations/ and schema.sql agree?" without a network
# or a credential. This answers the other question, the one that needs both:
# "is the live database actually the thing they describe?"
#
# It found its first faults the day it was written. `0038` had been recorded as
# applied and was not, `0049` had been run in the same sitting as `0050` and
# only `0050` took. Neither showed up as an error anywhere: a migration that
# never ran leaves nothing behind to notice, and a hand-written note in
# SETUP.md saying it ran is not evidence of anything.
#
# It reads. It writes nothing, creates nothing and drops nothing on the live
# project — every statement it sends is a catalog SELECT, and `introspect.sql`
# is the same file `db:verify` uses on both of its throwaway databases.
#
#   npm run db:audit -- 'postgresql://USER:PASSWORD@HOST:5432/postgres'
#   NEARSIDE_DB_URL='postgresql://…' npm run db:audit
#
# The connection string is the one under Project settings → Database. Pass it
# on the command line or in the environment; it is never written to a file
# here, and it must not be committed.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
NAME="nearside-audit-$$"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

URL="${1:-${NEARSIDE_DB_URL:-}}"
[ -n "$URL" ] || fail "usage: npm run db:audit -- 'postgresql://…'  (or set NEARSIDE_DB_URL)"

command -v docker >/dev/null || fail "docker not found — the reference schema is built in a throwaway container."
command -v psql   >/dev/null || fail "psql not found — needed to read the live catalog."

# ---------------------------------------------------------------------------
# The reference. schema.sql rather than a migration replay, because
# `npm run db:verify` already proves the two describe the same database — and
# it is run here first so that proof is from this checkout, not from memory.
# ---------------------------------------------------------------------------
say "proving schema.sql still matches migrations/"
"$HERE/verify.sh" >/dev/null || fail "db:verify failed — fix that before auditing a live project against it."

say "starting $IMAGE"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=audit -e POSTGRES_USER=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker logs "$NAME" 2>&1 | grep -q 'PostgreSQL init process complete' && break
  sleep 1
done
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "${ready:-}" = 1 ] || fail "Postgres did not come up within 60s."

say "building the reference from schema.sql"
{
  cat "$HERE/platform-shim.sql"
  sed 's/^CREATE EXTENSION IF NOT EXISTS pg_net;/-- [db:audit] pg_net stubbed by platform-shim.sql/' "$ROOT/schema.sql"
  cat "$ROOT/storage/setup.sql"
} > "$WORK/baseline.sql"
docker exec -i "$NAME" psql -U postgres -tAc 'CREATE DATABASE reference' >/dev/null
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres -d reference < "$WORK/baseline.sql" \
  > "$WORK/baseline.log" 2>&1 || { tail -20 "$WORK/baseline.log" >&2; fail "schema.sql failed to apply."; }

# One fold-and-sort, applied to both sides, so a multi-line constraint or policy
# body is one comparable fact. Same treatment db:verify gives its two databases.
normalize() {
  awk '/^## /{if(r)print r; r=$0; next} {gsub(/^[ \t]+|[ \t]+$/,""); if(NF)r=r" "$0} END{if(r)print r}' \
    | LC_ALL=C sort
}

docker exec -i "$NAME" psql -q -U postgres -d reference < "$HERE/introspect.sql" | normalize > "$WORK/reference.txt"

say "reading the live catalog"
psql -q -v ON_ERROR_STOP=1 "$URL" < "$HERE/introspect.sql" 2>"$WORK/live.err" | normalize > "$WORK/live.txt" || {
  sed 's/password=[^ ]*/password=***/' "$WORK/live.err" >&2
  fail "could not read the live database — check the connection string."
}
[ -s "$WORK/live.txt" ] || fail "the live database returned no facts at all, which is not a schema."

# ---------------------------------------------------------------------------
# Extensions are the one category that legitimately differs. A Supabase project
# carries pg_graphql, supabase_vault, pgjwt and friends that no migration here
# installs and the shim does not fake; diffing them would bury the findings
# that matter under a dozen lines nobody can act on. pg_net is the exception —
# 0014 installs it, the shim stubs it — so it is checked by name instead.
# ---------------------------------------------------------------------------
grep -v '^## extension ' "$WORK/reference.txt" > "$WORK/ref.cmp"
grep -v '^## extension ' "$WORK/live.txt"      > "$WORK/live.cmp"

# LC_ALL=C on `comm` as well as on the `sort` above: the two have to agree on
# collation or comm decides its inputs are unsorted and silently compares
# nothing, which reads exactly like a clean audit.
LC_ALL=C comm -23 "$WORK/ref.cmp" "$WORK/live.cmp" > "$WORK/missing.txt"
LC_ALL=C comm -13 "$WORK/ref.cmp" "$WORK/live.cmp" > "$WORK/extra.txt"

# A function is fingerprinted by the md5 of its body, so one whose body differs
# lands in both lists as two unrelated-looking facts with two hashes. That is
# the exact shape of the fault this script was written after — `set_conversation_pin`
# existed on the project, was executable, and held 0048's body instead of
# 0049's — so it is worth naming as one finding rather than two.
fn_key() { sed -n 's/^\(## function [^ ]*([^)]*)\) .*/\1/p' "$1" | LC_ALL=C sort -u; }
fn_key "$WORK/missing.txt" > "$WORK/missing.fn"
fn_key "$WORK/extra.txt"   > "$WORK/extra.fn"
LC_ALL=C comm -12 "$WORK/missing.fn" "$WORK/extra.fn" > "$WORK/changed.fn"

# Reported once, under its own heading, and taken out of the two lists below so
# each of those means exactly one thing: absent, or unexpected.
if [ -s "$WORK/changed.fn" ]; then
  for f in missing extra; do
    grep -vFf "$WORK/changed.fn" "$WORK/$f.txt" > "$WORK/$f.trimmed" || true
    mv "$WORK/$f.trimmed" "$WORK/$f.txt"
  done
fi

echo
printf '\033[1m%s\033[0m\n' "Live project vs. this checkout"
printf '  reference (schema.sql): %s facts\n' "$(wc -l < "$WORK/reference.txt")"
printf '  live:                   %s facts\n' "$(wc -l < "$WORK/live.txt")"
echo

printf '\033[1mExtensions on the live project\033[0m (informational — the platform installs most of these)\n'
grep '^## extension ' "$WORK/live.txt" | sed 's/^## extension /  /' || true
grep -q '^## extension pg_net ' "$WORK/live.txt" \
  && printf '  \033[32mpg_net present\033[0m — 0014'"'"'s push trigger can call out.\n' \
  || printf '  \033[31mpg_net MISSING\033[0m — 0014'"'"'s trigger cannot post, so no push is ever sent.\n'
echo

if [ -s "$WORK/changed.fn" ]; then
  printf '\033[31m%s\033[0m\n' "WRONG BODY ON LIVE — $(wc -l < "$WORK/changed.fn") function(s) that exist but are not the ones this repo describes."
  printf '  The riskiest kind: it is present, it is granted, and it fails only when\n'
  printf '  called. A plpgsql body is not resolved until it runs.\n\n'
  sed 's/^## function /  /' "$WORK/changed.fn"
  echo
fi

if [ -s "$WORK/missing.txt" ]; then
  printf '\033[31m%s\033[0m\n' "MISSING FROM LIVE — $(wc -l < "$WORK/missing.txt") fact(s) the repo describes and the database does not have."
  printf '  This is the half that matters: a migration that never ran.\n\n'
  sed 's/^## /  /' "$WORK/missing.txt"
  echo
fi

if [ -s "$WORK/extra.txt" ]; then
  printf '\033[33m%s\033[0m\n' "EXTRA ON LIVE — $(wc -l < "$WORK/extra.txt") fact(s) the database has and the repo does not describe."
  printf '  Some of these are the platform (rls_auto_enable, storage defaults) and are\n'
  printf '  noted in SETUP.md. Anything else is drift, and a stray grant or policy here\n'
  printf '  is a finding, not noise.\n\n'
  sed 's/^## /  /' "$WORK/extra.txt"
  echo
fi

if [ -s "$WORK/missing.txt" ]; then
  printf '\033[31m==> The live project is not what this checkout describes.\033[0m\n'
  printf '    Find the migration that adds a missing fact:\n'
  printf "      grep -rn '<object name>' supabase/migrations/\n"
  exit 1
fi

if [ -s "$WORK/extra.txt" ]; then
  printf '\033[33m==> Nothing is missing. Read the extras above and confirm each is the platform.\033[0m\n'
  exit 0
fi

printf '\033[32m==> The live project matches this checkout exactly (%s facts compared).\033[0m\n' \
  "$(wc -l < "$WORK/ref.cmp")"
