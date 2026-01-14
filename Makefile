.PHONY: help install ensure-deps dev build start lint format format-check test test-watch check demo demo-with-seed \
	db-up db-down db-logs db-migrate db-generate db-studio \
	stack-up stack-up-smee stack-down stack-down-smee stack-reset stack-reset-smee reset reset-smee \
	metabase-rebootstrap stack-logs stack-logs-smee

help:
	@echo "Targets:"
	@echo "  .env            Create .env from .env.example (if missing)"
	@echo "  install         Install dependencies (pnpm)"
	@echo "  dev             Start API in watch mode"
	@echo "  build           Build TypeScript -> dist/"
	@echo "  start           Run built server"
	@echo "  lint            Run ESLint"
	@echo "  format          Run Prettier (write)"
	@echo "  format-check    Run Prettier (check)"
	@echo "  test            Run Vitest"
	@echo "  test-watch      Run Vitest (watch)"
	@echo "  check           Run all local checks"
	@echo "  demo            One-command live demo (no seed)"
	@echo "  demo-with-seed  Demo + seed sample data"
	@echo "  db-up           Start local Postgres (docker compose)"
	@echo "  db-down         Stop local Postgres"
	@echo "  db-logs         Tail local Postgres logs"
	@echo "  db-generate     Generate Drizzle migrations (NAME=create_table_...)"
	@echo "  db-migrate      Apply migrations"
	@echo "  db-studio       Open Drizzle Studio"
	@echo "  stack-up        Start stack (API+Postgres+Metabase)"
	@echo "  stack-up-smee   Start stack (+2 smee relays)"
	@echo "  stack-down      Stop stack"
	@echo "  stack-down-smee Stop stack (+2 smee relays)"
	@echo "  stack-reset     Stop stack + remove volumes (wipe data)"
	@echo "  stack-reset-smee Stop stack (+2 smee relays) + remove volumes (wipe data)"
	@echo "  reset           Alias for stack-reset"
	@echo "  reset-smee      Alias for stack-reset-smee"
	@echo "  metabase-rebootstrap Re-run Metabase bootstrap (dashboard/cards)"
	@echo "  stack-logs      Tail stack logs"
	@echo "  stack-logs-smee Tail stack logs (+2 smee relays)"

install:
	corepack enable
	pnpm install
.env:
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example"; fi

ensure-deps:
	@if [ ! -x node_modules/.bin/tsx ]; then $(MAKE) install; fi

dev: ensure-deps .env
	pnpm dev

build: ensure-deps
	pnpm build

start: ensure-deps
	pnpm start

lint: ensure-deps
	pnpm lint

format: ensure-deps
	pnpm format

format-check: ensure-deps
	pnpm format:check

test: ensure-deps
	pnpm test

test-watch: ensure-deps
	pnpm test:watch

check:
	pnpm format:check
	pnpm lint
	pnpm test
	pnpm build

demo: .env ## Start stack + two smee relays (no seeding)
	@bash scripts/check-prereqs.sh
	node scripts/smee-ensure.mjs
	$(MAKE) stack-up-smee
	@MB_BOOTSTRAP_ID=$$(docker compose ps --all -q metabase-bootstrap); \
	if [ -n "$$MB_BOOTSTRAP_ID" ]; then \
		echo "Waiting for Metabase bootstrap to finish..."; \
		MB_EXIT=$$(docker wait $$MB_BOOTSTRAP_ID); \
		if [ "$$MB_EXIT" -ne 0 ]; then \
			echo "Metabase bootstrap failed (exit $$MB_EXIT). Run: docker compose logs metabase-bootstrap"; \
			exit $$MB_EXIT; \
		fi; \
	fi
	node scripts/demo-info.mjs

demo-with-seed: .env ## Demo + seed sample data
	@bash scripts/check-prereqs.sh
	node scripts/smee-ensure.mjs
	$(MAKE) stack-up-smee
	@MB_BOOTSTRAP_ID=$$(docker compose ps --all -q metabase-bootstrap); \
	if [ -n "$$MB_BOOTSTRAP_ID" ]; then \
		echo "Waiting for Metabase bootstrap to finish..."; \
		MB_EXIT=$$(docker wait $$MB_BOOTSTRAP_ID); \
		if [ "$$MB_EXIT" -ne 0 ]; then \
			echo "Metabase bootstrap failed (exit $$MB_EXIT). Run: docker compose logs metabase-bootstrap"; \
			exit $$MB_EXIT; \
		fi; \
	fi
	node scripts/seed-demo.mjs

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

db-logs:
	docker compose logs -f postgres

db-generate: ensure-deps
	@if [ -n "$(NAME)" ]; then pnpm db:generate --name "$(NAME)"; else pnpm db:generate; fi

db-migrate: ensure-deps
	pnpm db:migrate

db-studio: ensure-deps
	pnpm db:studio

stack-up:
	docker compose up -d --build postgres api metabase db-bootstrap metabase-bootstrap

stack-up-smee:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml up -d --build postgres api metabase db-bootstrap metabase-bootstrap smee-classified-notification smee-classifieds-export

stack-down:
	docker compose down

stack-down-smee:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml down

stack-reset:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml down -v --remove-orphans --timeout 0
	@docker compose -f docker-compose.yml -f docker-compose.smee.yml rm -fsv >/dev/null 2>&1 || true

stack-reset-smee:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml down -v --remove-orphans --timeout 0
	@docker compose -f docker-compose.yml -f docker-compose.smee.yml rm -fsv >/dev/null 2>&1 || true

reset:
	$(MAKE) stack-reset

reset-smee:
	$(MAKE) stack-reset-smee

metabase-rebootstrap:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml up --force-recreate --no-deps metabase-bootstrap

stack-logs:
	docker compose logs -f postgres api metabase db-bootstrap metabase-bootstrap

stack-logs-smee:
	docker compose -f docker-compose.yml -f docker-compose.smee.yml logs -f postgres api metabase db-bootstrap metabase-bootstrap smee-classified-notification smee-classifieds-export
