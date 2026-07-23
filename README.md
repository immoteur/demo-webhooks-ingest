# Webhook Ingestion API (Demo)

Demo Node.js (TypeScript) webhook ingestion API that persists webhook events to PostgreSQL (Drizzle ORM + managed migrations), optimized for Metabase to read directly from the DB.

This repo is a companion project for:

- Immoteur: https://immoteur.com
- Full tutorial (step-by-step): https://immoteur.com/tutorials/first-bi-tool-metabase

## Requirements

- Node.js 24+
- Docker + Docker Compose
- `corepack` (bundled with Node) to run `pnpm`

## Commands (Makefile)

Run `make help` to see all targets.

## One-command local demo (wow mode)

```bash
make demo
```

This starts Postgres + API + Metabase via Docker Compose, bootstraps Metabase on first run, generates **two smee relays** (one per webhook endpoint), and prints URLs/credentials (including a **public Metabase dashboard URL** that works without logging in).

To also seed sample data:

```bash
make demo-with-seed
```

## Quickstart

```bash
make install
cp .env.example .env
make db-up
make db-migrate
make dev
```

API listens on `http://localhost:3000` (or `PORT` from `.env`).

Before running in any shared environment, update the default credentials in
`.env` (all `CHANGE_ME` values) and avoid exposing Postgres publicly.

## Code structure

- `src/http/routes.ts`: mounts all controllers in one place
- `src/http/controllers/*`: Express routers (one file per controller)
- `src/http/mappers/*`: HTTP payload → persistence DTO mapping
- `@immoteur/openapi-zod`: OpenAPI-derived Zod schemas + TypeScript types (payload validation)
- `src/modules/webhooks/*`: webhook ingestion + `webhook_events` persistence
- `src/modules/classifieds/*`: `classifieds` mapping + persistence (incl. images + price history)
- `src/db/*`: Drizzle schema, migrations, client

## Docker Compose stack (API + Postgres + Metabase + smee)

This starts:

- Postgres (port `${POSTGRES_HOST_PORT:-15432}` on host)
- API (port `${API_HOST_PORT:-8080}` on host) and runs migrations on startup
- Metabase (port `${METABASE_HOST_PORT:-3001}` on host)
- Optional smee relays (forwards smee.io → API inside the Compose network)

```bash
cp .env.example .env
make stack-up

# Optional: enable the 2 smee relays
node scripts/smee-ensure.mjs
make stack-up-smee
```

Defaults:

- smee targets (inside Compose network):
  - classified-notification → `http://api:3000/webhooks/classified-notification`
  - classifieds-export → `http://api:3000/webhooks/classifieds-export`
- API: `http://localhost:8080`
- Metabase UI: `http://localhost:3001`

Troubleshooting:

- If `db-bootstrap` exits with code `2`, it couldn’t connect to Postgres (most often: credentials don’t match an existing Docker volume). For a clean demo reset: `make stack-reset-smee` (wipes volumes).
- If you change `scripts/metabase-bootstrap.mjs` and don’t see dashboard updates, re-run the one-shot bootstrap container: `make metabase-rebootstrap` (or reset volumes for a full clean run).

## Production (VPS) with Caddy (TLS)

This repo includes a simple Caddy reverse-proxy setup (`docker-compose.caddy.yml` + `docker/caddy/Caddyfile`) to expose **only** `80/443` publicly and keep Postgres/Metabase/API unexposed.

1. Create DNS records pointing to your VPS:
   - `API_DOMAIN` (e.g. `api.demo.example.com`)
   - `METABASE_DOMAIN` (e.g. `metabase.demo.example.com`)
2. Create `.env` from `.env.example` and set at least:
   - `POSTGRES_PASSWORD`, `API_DB_PASSWORD`, `METABASE_READER_PASSWORD`, `METABASE_ADMIN_PASSWORD`
   - `ACME_EMAIL`, `API_DOMAIN`, `METABASE_DOMAIN`
   - Optional: `WEBHOOK_ALLOWED_IP` (single IP/CIDR) to enable the API’s `/webhooks/*` IP allowlist
   - Optional: `WEBHOOK_EVENTS_RETENTION_HOURS` (default `24`) and `CLASSIFIEDS_LAST_SEEN_RETENTION_DAYS` (default `7`) for hourly retention cleanup
   - Optional: `WEBHOOK_EVENTS_MAX_ROWS` and `CLASSIFIEDS_MAX_ROWS` (default `0`, disabled) to cap row counts to the newest data (webhook events only prune unreferenced rows)
3. Start the production stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
```

URLs:

- API: `https://$API_DOMAIN`
- Metabase: `https://$METABASE_DOMAIN`

Notes:

- In production mode, the API enables Express `trust proxy` (1 hop). Caddy overwrites `X-Forwarded-For`/`X-Real-IP` so client IPs can’t be spoofed.
- Optional: set `METABASE_PUBLIC_DASHBOARD_UUID` to enable a stable pretty URL `https://$METABASE_DOMAIN/demo` → `https://$METABASE_DOMAIN/public/dashboard/<uuid>`.

## Webhook endpoints

This service exposes **reliable** ingestion endpoints under:

- `POST /webhooks/classified-notification`
- `POST /webhooks/classifieds-export`

Each request is JSON-parsed and validated with OpenAPI-derived `Zod.safeParse`, then recorded in `webhook_events` with `payload` (when JSON parses), `body_sha256`, `request_ip`, and `error` when validation fails. The demo intentionally does **not** persist raw request bodies or headers.

### IP allowlist

If `WEBHOOK_ALLOWED_IP` is set (single IP), requests to `/webhooks/*` are rejected with `403` unless they come from that IP.

### Example request

```bash
curl -sS -X POST "http://localhost:8080/webhooks/classified-notification" \
  -H "content-type: application/json" \
  -d '{"id":"7f6e3b4d-9c22-46a0-8f20-0d1a2b3c4d5e","type":"created"}'
```

To send a realistic payload from this repo:

```bash
curl -sS -X POST "http://localhost:8080/webhooks/classified-notification" \
  -H "content-type: application/json" \
  -d @demo/payloads/classified-notification.example.json

curl -sS -X POST "http://localhost:8080/webhooks/classifieds-export" \
  -H "content-type: application/json" \
  -d @demo/payloads/classifieds-export.example.json
```

If you’re running the API directly (no Docker), use `http://localhost:3000` instead of `:8080`.

## Migrations (Drizzle Kit)

- Edit schema: `src/db/schema.ts`
- Generate migration: `make db-generate NAME=create_table_...` (or omit `NAME` for Drizzle defaults)
- Apply migrations: `make db-migrate`

`make db-migrate` is safe to run on a clean DB.

Migrations live in `src/db/migrations/`.

## OpenAPI schemas/types

This demo validates webhook payloads using `@immoteur/openapi-zod` (Zod schemas + TypeScript types generated from the Immoteur OpenAPI spec).

To update schemas/types, bump `@immoteur/openapi-zod` in `package.json` and reinstall.

## Adding a new webhook handler

This demo is intentionally limited to classifieds webhooks:

- `classified-notification`
- `classifieds-export`

To add another webhook:

1. Ensure `@immoteur/openapi-zod` contains the payload schema for the new webhook (update/publish it if needed), then bump the dependency in this repo.
2. Create a controller in `src/http/controllers/` (e.g. `webhooks.<name>.controller.ts`) using the imported schema + `ingestWebhook`.
3. Register it in `src/http/routes.ts`.
4. Add/update tests in `tests/webhooks.test.ts`.

## Security

Please report vulnerabilities privately. See `SECURITY.md`.

## Contributing

See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

## License

MIT. See `LICENSE`.

## Metabase

Metabase should connect directly to Postgres using a read-only user.

### Connection info (local)

- Host: `localhost`
- Port: `15432`
- Database: `webhooks_ingest`
- User: `metabase_reader` (create below)

Metabase can query:

- `webhook_events` (append-only raw ingestion log)
- `classifieds` (flattened columns for the `classified-notification` payload)
- `classified_images` (one row per image, FK to `classifieds`)
- `classified_price_history` (one row per price change, FK to `classifieds`)

### Read-only user SQL

When using Docker Compose, the `metabase_reader` role is created automatically **on first Postgres init** using:

- `METABASE_READER_USER` (default: `metabase_reader`)
- `METABASE_READER_PASSWORD` (default: `CHANGE_ME`)

The API uses a separate Postgres role (created automatically on first init):

- `API_DB_USER` (default: `api_writer`)
- `API_DB_PASSWORD`

If you run Postgres outside Compose, run as a superuser (e.g. `postgres`):

```sql
create user metabase_reader with password 'CHANGE_ME';

grant connect on database webhooks_ingest to metabase_reader;
grant usage on schema public to metabase_reader;

grant select on all tables in schema public to metabase_reader;
alter default privileges in schema public grant select on tables to metabase_reader;

grant select on all sequences in schema public to metabase_reader;
alter default privileges in schema public grant select on sequences to metabase_reader;
```
