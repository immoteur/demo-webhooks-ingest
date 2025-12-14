#!/usr/bin/env sh
set -eu

POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-webhooks_ingest}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"

API_DB_USER="${API_DB_USER:-api_writer}"
API_DB_PASSWORD="${API_DB_PASSWORD:-CHANGE_ME}"

METABASE_READER_USER="${METABASE_READER_USER:-metabase_reader}"
METABASE_READER_PASSWORD="${METABASE_READER_PASSWORD:-CHANGE_ME}"

export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-3}"

echo "[db-bootstrap] Ensuring DB roles exist..."

echo "[db-bootstrap] Waiting for Postgres..."
i=0
while [ "$i" -lt 60 ]; do
  if psql -v ON_ERROR_STOP=1 \
    --host "${POSTGRES_HOST}" \
    --port "${POSTGRES_PORT}" \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    --command "select 1" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if ! psql -v ON_ERROR_STOP=1 \
  --host "${POSTGRES_HOST}" \
  --port "${POSTGRES_PORT}" \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --command "select 1" >/dev/null 2>&1; then
  echo "[db-bootstrap] ERROR: Unable to connect to Postgres (psql exit 2)." >&2
  echo "[db-bootstrap] - host: ${POSTGRES_HOST}:${POSTGRES_PORT}" >&2
  echo "[db-bootstrap] - user: ${POSTGRES_USER}" >&2
  echo "[db-bootstrap] - db:   ${POSTGRES_DB}" >&2
  echo "[db-bootstrap] psql output:" >&2
  psql -v ON_ERROR_STOP=1 \
    --host "${POSTGRES_HOST}" \
    --port "${POSTGRES_PORT}" \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    --command "select 1" >&2 || true
  echo "[db-bootstrap] Tip: If you changed POSTGRES_* vars since the Docker volume was created, either revert them or reset volumes (dev/demo):" >&2
  echo "[db-bootstrap]   - make stack-reset (or make stack-reset-smee)" >&2
  exit 2
fi

psql -v ON_ERROR_STOP=1 \
  --host "${POSTGRES_HOST}" \
  --port "${POSTGRES_PORT}" \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  -v db_name="${POSTGRES_DB}" \
  -v api_db_user="${API_DB_USER}" \
  -v api_db_password="${API_DB_PASSWORD}" \
  -v metabase_reader_user="${METABASE_READER_USER}" \
  -v metabase_reader_password="${METABASE_READER_PASSWORD}" <<'SQL'
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

-- Ensure Metabase can read objects created by the API role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"api_db_user" IN SCHEMA public
  GRANT SELECT ON TABLES TO :"metabase_reader_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"api_db_user" IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO :"metabase_reader_user";

-- Smooth upgrades: if the DB was previously initialized with a different owner,
-- transfer ownership of existing objects to the API role so migrations keep working.
SELECT format('ALTER TABLE public.%I OWNER TO %I', tablename, :'api_db_user')
FROM pg_tables
WHERE schemaname = 'public'
\gexec

SELECT format('ALTER TABLE drizzle.%I OWNER TO %I', tablename, :'api_db_user')
FROM pg_tables
WHERE schemaname = 'drizzle'
\gexec

SELECT format('ALTER SEQUENCE public.%I OWNER TO %I', sequence_name, :'api_db_user')
FROM information_schema.sequences
WHERE sequence_schema = 'public'
\gexec

SELECT format('ALTER SEQUENCE drizzle.%I OWNER TO %I', sequence_name, :'api_db_user')
FROM information_schema.sequences
WHERE sequence_schema = 'drizzle'
\gexec
SQL

echo "[db-bootstrap] Done."
