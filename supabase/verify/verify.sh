#!/usr/bin/env bash
#
# Nearside — prove schema.sql and migrations/ describe the same database.
#
# Builds two throwaway databases inside one disposable Postgres container:
#
#   from_migrations  platform shim + every file in migrations/apply-order.txt,
#                    in that order, + storage/setup.sql
#   from_schema      platform shim + schema.sql
#
# then fingerprints both with verify/introspect.sql and diffs the results.
# A clean diff is what makes schema.sql trustworthy as the single description
# of this project: it cannot silently drift from the history that produced it.
#
# Nothing here touches the live project. It needs Docker and nothing else —
# no Supabase account, no network beyond the image pull, no credentials.
#
#   npm run db:verify
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
NAME="nearside-verify-$$"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

command -v docker >/dev/null || fail "docker not found — db:verify needs it to build a throwaway Postgres."
docker info >/dev/null 2>&1 || fail "docker is installed but not running."

say "starting $IMAGE"
docker run -d --rm --name "$NAME" \
  -e POSTGRES_PASSWORD=verify \
  -e POSTGRES_USER=postgres \
  "$IMAGE" >/dev/null

# The image's entrypoint starts a temporary server to run initdb, then stops it
# and starts the real one. A plain `select 1` succeeds against that temporary
# server, so polling for it alone connects to an instance that is about to be
# shut down — the replay then dies partway through with "No such file or
# directory" on the socket. Wait for the entrypoint to say it is done first.
for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q 'PostgreSQL init process complete'; then
    break
  fi
  sleep 1
done
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "${ready:-}" = 1 ] || fail "Postgres did not come up within 60s."

psql_run() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres -d "$1"; }

# ---------------------------------------------------------------------------
# Assemble the two scripts on the host, then pipe each in as one transaction's
# worth of input. Fewer docker round trips, and the failing line number in an
# error message points at something a human can find.
# ---------------------------------------------------------------------------

# pg_net cannot be installed in a stock image. The shim provides net.http_post
# so 0014's trigger function still compiles; only the CREATE EXTENSION line is
# stripped, and it is stripped from both paths so neither gains an extension the
# other lacks.
strip_pg_net() { sed 's/^CREATE EXTENSION IF NOT EXISTS pg_net;/-- [db:verify] pg_net stubbed by platform-shim.sql/' "$1"; }

# Checked before assembling rather than during: the assembly below runs in a
# subshell feeding a redirect, where `fail`'s exit would end only the subshell
# and leave the outer script replaying a silently truncated script.
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  [ -f "$ROOT/migrations/$line" ] || fail "apply-order.txt names $line, which does not exist."
done < "$ROOT/migrations/apply-order.txt"

for f in "$ROOT/schema.sql" "$ROOT/storage/setup.sql" "$HERE/platform-shim.sql" "$HERE/introspect.sql"; do
  [ -f "$f" ] || fail "missing $f"
done

say "replaying migrations"
{
  cat "$HERE/platform-shim.sql"
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    printf '\n\\echo >>> %s\n' "$line"
    strip_pg_net "$ROOT/migrations/$line"
    # storage/setup.sql runs immediately after 0001, as its header says.
    if [ "$line" = "0001_init.sql" ]; then
      printf '\n\\echo >>> storage/setup.sql\n'
      cat "$ROOT/storage/setup.sql"
    fi
  done < "$ROOT/migrations/apply-order.txt"
} > "$WORK/replay.sql"

docker exec -i "$NAME" psql -U postgres -tAc 'CREATE DATABASE from_migrations' >/dev/null
psql_run from_migrations < "$WORK/replay.sql" > "$WORK/replay.log" 2>&1 || {
  tail -30 "$WORK/replay.log" >&2
  fail "migration replay failed — see above."
}

# storage/setup.sql is applied to BOTH databases, and is the reason the mime
# whitelist can no longer drift. The replay runs it after 0001 and then lets
# 0025 update the bucket; the baseline runs it alone. If someone edits 0025
# without editing the setup script (or the reverse), the two buckets end up
# configured differently and the '## bucket' facts disagree.
say "applying schema.sql"
docker exec -i "$NAME" psql -U postgres -tAc 'CREATE DATABASE from_schema' >/dev/null
{
  cat "$HERE/platform-shim.sql"
  strip_pg_net "$ROOT/schema.sql"
  cat "$ROOT/storage/setup.sql"
} > "$WORK/baseline.sql"
psql_run from_schema < "$WORK/baseline.sql" > "$WORK/baseline.log" 2>&1 || {
  tail -30 "$WORK/baseline.log" >&2
  fail "schema.sql failed to apply."
}

say "fingerprinting"
# pg_get_constraintdef and a policy's USING clause are pretty-printed across
# several lines. Each fact has to be one line before it can be sorted, so
# anything that is not a new '## ' record is folded back onto the previous one.
for db in from_migrations from_schema; do
  docker exec -i "$NAME" psql -q -U postgres -d "$db" < "$HERE/introspect.sql" \
    | awk '/^## /{if(r)print r; r=$0; next} {gsub(/^[ \t]+|[ \t]+$/,""); if(NF)r=r" "$0} END{if(r)print r}' \
    | LC_ALL=C sort > "$WORK/$db.txt"
done

if diff -u "$WORK/from_migrations.txt" "$WORK/from_schema.txt" > "$WORK/diff.txt"; then
  printf '\033[32m==> schema.sql matches the %s migrations exactly (%s facts compared).\033[0m\n' \
    "$(grep -cvE '^\s*(#|$)' "$ROOT/migrations/apply-order.txt")" \
    "$(wc -l < "$WORK/from_migrations.txt")"
  exit 0
fi

printf '\033[31m==> schema.sql and migrations/ disagree.\033[0m\n' >&2
printf '    -  only in the migration replay\n    +  only in schema.sql\n\n' >&2
sed '1,2d' "$WORK/diff.txt" >&2
exit 1
