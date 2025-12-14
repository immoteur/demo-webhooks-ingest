#!/usr/bin/env bash
set -euo pipefail

# Creates a dedicated Postgres role for the API on first database initialization.
#
# Config via env (defaults are demo-friendly; override for prod):
#   API_DB_USER
#   API_DB_PASSWORD
#
# Also ensures the `pgcrypto` extension exists so migrations can run with a non-superuser role.

API_DB_USER="${API_DB_USER:-api_writer}"
API_DB_PASSWORD="${API_DB_PASSWORD:-CHANGE_ME}"

METABASE_READER_USER="${METABASE_READER_USER:-metabase_reader}"

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v db_name="${POSTGRES_DB}" \
  -v api_db_user="${API_DB_USER}" \
  -v api_db_password="${API_DB_PASSWORD}" \
  -v metabase_reader_user="${METABASE_READER_USER}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

SELECT format('CREATE ROLE %I LOGIN', :'api_db_user')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'api_db_user'
)
\gexec

ALTER ROLE :"api_db_user" LOGIN PASSWORD :'api_db_password';

GRANT CONNECT ON DATABASE :"db_name" TO :"api_db_user";
GRANT CREATE ON DATABASE :"db_name" TO :"api_db_user";
GRANT USAGE, CREATE ON SCHEMA public TO :"api_db_user";

CREATE SCHEMA IF NOT EXISTS drizzle;
ALTER SCHEMA drizzle OWNER TO :"api_db_user";

ALTER DEFAULT PRIVILEGES FOR ROLE :"api_db_user" IN SCHEMA public
  GRANT SELECT ON TABLES TO :"metabase_reader_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"api_db_user" IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO :"metabase_reader_user";
SQL
