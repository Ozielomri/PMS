#!/usr/bin/env bash
# Apply the migrations to a plain Postgres database (no Supabase/Docker needed), adding the
# Supabase shim first if the database has no auth schema. For Supabase itself use
# `supabase start` / `supabase db reset` (local) or `supabase db push` (hosted).
#
#   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/pms_dev scripts/db-apply.sh
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
cd "$(dirname "$0")/.."

has_auth=$(psql "$DATABASE_URL" -tAc "select 1 from pg_namespace where nspname = 'auth'")
if [ "$has_auth" != "1" ]; then
  echo "applying tests/db/supabase-shim.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f tests/db/supabase-shim.sql
fi
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done
