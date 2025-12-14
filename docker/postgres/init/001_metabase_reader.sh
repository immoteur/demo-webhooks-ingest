#!/usr/bin/env bash
set -euo pipefail

# Creates a read-only Postgres role for Metabase on first database initialization.
#
# Config via env (defaults are demo-friendly; override for prod):
#   METABASE_READER_USER
#   METABASE_READER_PASSWORD

METABASE_READER_USER="${METABASE_READER_USER:-metabase_reader}"
METABASE_READER_PASSWORD="${METABASE_READER_PASSWORD:-CHANGE_ME}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v db_name="${POSTGRES_DB}" \
  -v metabase_reader_user="${METABASE_READER_USER}" \
  -v metabase_reader_password="${METABASE_READER_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'metabase_reader_user')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'metabase_reader_user'
)
\gexec

ALTER ROLE :"metabase_reader_user" LOGIN PASSWORD :'metabase_reader_password';

GRANT USAGE ON SCHEMA public TO :"metabase_reader_user";

GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"metabase_reader_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"metabase_reader_user";

GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO :"metabase_reader_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO :"metabase_reader_user";

GRANT CONNECT ON DATABASE :"db_name" TO :"metabase_reader_user";
SQL
