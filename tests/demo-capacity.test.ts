import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { Classified as classifiedSchema } from '@immoteur/openapi-zod';
import type { Classified } from '@immoteur/openapi-zod';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';

import type * as Client from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type * as Storage from '../src/modules/retention/demo-storage.js';
import type * as Server from '../src/server.js';

describe('demo capacity and recovery', () => {
  let container: StartedPostgreSqlContainer;
  let db: typeof Client.db;
  let pool: typeof Client.pool;
  let DemoStorage: typeof Storage.DemoStorage;
  let createApp: typeof Server.createApp;
  let item: Classified;
  let freeBytes = 32 * 1024 ** 3;
  const queries: { query: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('demo_capacity')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.LOG_LEVEL = 'silent';
    process.env.DEMO_CAPACITY_PATH = process.cwd();
    process.env.DEMO_MIN_FREE_BYTES = '0';
    const client = await import('../src/db/client.js');
    pool = client.pool;
    db = drizzle(pool, {
      schema,
      logger: {
        logQuery: (query, params) => {
          queries.push({ query, params });
        },
      },
    });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src/db/migrations') });
    ({ DemoStorage } = await import('../src/modules/retention/demo-storage.js'));
    ({ createApp } = await import('../src/server.js'));
    item = classifiedSchema.parse(
      JSON.parse(await readFile('demo/payloads/classified-notification.example.json', 'utf8')),
    );
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE classified_images, classified_price_history, classifieds, webhook_events`,
    );
    freeBytes = 32 * 1024 ** 3;
    queries.length = 0;
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  function storage(overrides: Partial<Storage.DemoStorageSettings> = {}): Storage.DemoStorage {
    // Filesystem capacity is an external boundary; the real PostgreSQL database remains under test.
    return new DemoStorage(
      {
        mode: 'sample',
        databaseMaxBytes: 8 * 1024 ** 3,
        minimumFreeBytes: 20 * 1024 ** 3,
        capacityPath: '/capacity',
        expectedDatabase: 'demo_capacity',
        ...overrides,
      },
      db,
      async () => freeBytes,
    );
  }

  async function record(
    target: Storage.DemoStorage,
    items: Classified[] = [item],
  ): Promise<Storage.StorageOutcome> {
    return target.record({
      ip: '127.0.0.1',
      eventType: 'classified-notification',
      rawBody: JSON.stringify(items),
      items,
      notificationType: null,
      error: null,
    });
  }

  it('stores a bounded whole-item sample without retaining raw payloads', async () => {
    // Given
    const target = storage();
    await target.refresh();
    const items = Array.from({ length: 10 }, () => ({ ...item, id: randomUUID() }));

    // When
    const result = await record(target, items);
    const receipts = await db.select().from(schema.webhookEvents);
    const rows = await db.select().from(schema.classifieds);

    // Then
    expect(result).toMatchObject({ storage: 'sampled', storedItems: 5 });
    expect(rows).toHaveLength(5);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.payload).toBeNull();
    expect(receipts[0]?.requestIp).toBe('127.0.0.1');
  });

  it('bounds concurrent admission without accumulating queued writes', async () => {
    // Given
    const target = storage();
    await target.refresh();

    // When
    const results = await Promise.all(Array.from({ length: 20 }, () => record(target)));

    // Then
    expect(results.filter((result) => result.storage === 'sampled')).toHaveLength(1);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });

  it('skips an oversized whole item without retaining its raw content', async () => {
    // Given
    const target = storage();
    await target.refresh();
    const oversized = { ...item, description: 'x'.repeat(65536) };

    // When
    const result = await record(target, [oversized]);

    // Then
    expect(result).toMatchObject({ storage: 'skipped', reason: 'item-limit', storedItems: 0 });
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it('preserves request IP metadata through the healthy sample HTTP route', async () => {
    // Given
    const target = storage();
    await target.refresh();

    // When
    const response = await request(createApp({ storage: target }))
      .post('/webhooks/classified-notification')
      .send(item);
    const receipts = await db.select().from(schema.webhookEvents);

    // Then
    expect(response.status).toBe(200);
    expect(response.body.storage).toBe('sampled');
    expect(receipts[0]?.requestIp).toMatch(/127\.0\.0\.1$/);
  });

  it('defers across independent pools and safely races eviction at both caps', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['Date'] });
    await db.execute(sql`INSERT INTO webhook_events(id,body_sha256,received_at)
      SELECT gen_random_uuid(), 'boundary-fixture', now() - interval '1 minute' + n * interval '1 microsecond'
      FROM generate_series(1,1000) n`);
    const receipts = await db.select().from(schema.webhookEvents).limit(1000);
    const { mapClassifiedToUpsertDto } = await import('../src/http/mappers/classified.mapper.js');
    for (let offset = 0; offset < receipts.length; offset += 100) {
      await db.insert(schema.classifieds).values(
        receipts.slice(offset, offset + 100).map(
          (receipt) =>
            mapClassifiedToUpsertDto({
              provider: 'fixture',
              classified: { ...item, id: randomUUID() },
              notificationType: null,
              webhookEventId: receipt.id,
              receivedAt: receipt.receivedAt,
            }).classified,
        ),
      );
    }
    const otherPool = new Pool({
      connectionString: pool.options.connectionString,
      max: 1,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
    });
    const first = storage();
    const second = new DemoStorage(
      first.settings,
      drizzle(otherPool, { schema }),
      async () => freeBytes,
    );
    await Promise.all([first.refresh(), second.refresh()]);
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(319984002)');
    let holding = true;

    // When
    try {
      const deferred = await Promise.all([record(first), record(second)]);
      await holder.query('ROLLBACK');
      holder.release();
      holding = false;
      vi.setSystemTime(Date.now() + 1000);
      const replay = await Promise.all([
        record(first, [{ ...item, id: randomUUID() }]),
        record(second, [{ ...item, id: randomUUID() }]),
      ]);
      const finalReceipts = await db.select().from(schema.webhookEvents);
      const finalListings = await db.select().from(schema.classifieds);

      // Then
      expect(deferred).toEqual([
        { storage: 'skipped', reason: 'contention', storedItems: 0 },
        { storage: 'skipped', reason: 'contention', storedItems: 0 },
      ]);
      expect(replay.some((result) => result.storage === 'sampled')).toBe(true);
      expect(
        replay.every((result) => result.storage === 'sampled' || result.reason === 'contention'),
      ).toBe(true);
      expect(finalReceipts.length).toBeLessThanOrEqual(1000);
      expect(finalListings.length).toBeLessThanOrEqual(1000);
    } finally {
      if (holding) {
        await holder.query('ROLLBACK');
        holder.release();
      }
      await otherPool.end();
    }
  });

  it('continues acknowledgement when storage probes are stale', async () => {
    // Given
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const target = storage();
    await target.refresh();
    vi.setSystemTime(Date.now() + 10_001);

    // When
    const result = await request(createApp({ storage: target }))
      .post('/webhooks/classified-notification')
      .send(item);

    // Then
    expect(result.status).toBe(200);
    expect(result.body.storage).toBe('skipped');
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it('does not let referenced receipts defeat the total receipt cap', async () => {
    // Given
    await db.execute(sql`INSERT INTO webhook_events(id,body_sha256,received_at)
      SELECT gen_random_uuid(), 'fixture', now() + n * interval '1 microsecond' FROM generate_series(1,1001) n`);
    const [receipt] = await db.select().from(schema.webhookEvents).limit(1);
    const { mapClassifiedToUpsertDto } = await import('../src/http/mappers/classified.mapper.js');
    if (!receipt) throw new Error('Missing fixture receipt');
    const dto = mapClassifiedToUpsertDto({
      provider: 'fixture',
      classified: item,
      notificationType: null,
      webhookEventId: receipt.id,
      receivedAt: receipt.receivedAt,
    });
    await db.insert(schema.classifieds).values(dto.classified);
    const target = storage();
    await target.refresh();

    // When
    await record(target, []);
    const receipts = await db.select().from(schema.webhookEvents);
    const pruning = queries.find((entry) =>
      entry.query.includes('DELETE FROM classifieds WHERE last_webhook_event_id'),
    );

    // Then
    expect(receipts.length).toBeLessThanOrEqual(1000);
    expect(pruning).toBeDefined();
    if (!pruning) throw new Error('Missing executed pruning query');
    const explanation = await pool.query('EXPLAIN (FORMAT JSON) ' + pruning.query, pruning.params);
    expect(explanation.rows).toHaveLength(1);
  });

  it('reclaims physical relation allocation during guarded capacity recovery', async () => {
    // Given
    await db.execute(sql`INSERT INTO webhook_events(body_sha256,payload)
      SELECT 'fixture', jsonb_build_object('raw', (SELECT string_agg(md5(n::text || g::text || random()::text),'')
      FROM generate_series(1,200) g)) FROM generate_series(1,500) n`);
    const before = await pool.query<{ bytes: string }>(
      "SELECT pg_total_relation_size('webhook_events')::text AS bytes",
    );
    const target = storage({ databaseMaxBytes: 1 });

    // When
    await target.maintain();
    const after = await pool.query<{ bytes: string }>(
      "SELECT pg_total_relation_size('webhook_events')::text AS bytes",
    );

    // Then
    expect(Number(after.rows[0]?.bytes)).toBeLessThan(Number(before.rows[0]?.bytes));
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
    expect(target.metrics()).toContain('demo_ingest_resets_total 1');
  });

  it('defers reset under an active reader and recovers after that reader exits', async () => {
    // Given
    await db.insert(schema.webhookEvents).values({ bodySha256: 'fixture' });
    const reader = await pool.connect();
    await reader.query('BEGIN');
    await reader.query('SELECT id FROM webhook_events');
    const target = storage({ databaseMaxBytes: 1 });

    // When
    try {
      await target.maintain();
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
    const deferred = await db.select().from(schema.webhookEvents);
    await target.maintain();

    // Then
    expect(deferred).toHaveLength(1);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it('refuses destructive reset when another table references the demo dataset', async () => {
    // Given
    await db.insert(schema.webhookEvents).values({ bodySha256: 'fixture' });
    await db.execute(sql`CREATE TABLE extra_dependency(id uuid REFERENCES webhook_events(id))`);
    const target = storage({ databaseMaxBytes: 1 });

    // When
    try {
      await target.maintain();
    } finally {
      await db.execute(sql`DROP TABLE extra_dependency`);
    }

    // Then
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
    expect(target.ready).toBe(false);
  });

  it('holds the free-space reserve until hysteresis permits recovery', async () => {
    // Given
    const target = storage();
    freeBytes = 19 * 1024 ** 3;
    await target.refresh();

    // When
    const underPressure = await record(target);
    freeBytes = 22 * 1024 ** 3;
    await target.refresh();
    const beforeResume = target.ready;
    freeBytes = 25 * 1024 ** 3;
    await target.refresh();

    // Then
    expect(underPressure.storage).toBe('skipped');
    expect(beforeResume).toBe(false);
    expect(target.ready).toBe(true);
  });

  it('never automatically resets explicit persistence mode', async () => {
    // Given
    await db.insert(schema.webhookEvents).values({ bodySha256: 'fixture' });
    const target = storage({ mode: 'persist', databaseMaxBytes: 1 });

    // When
    await target.maintain();
    const response = await request(createApp({ storage: target }))
      .post('/webhooks/classified-notification')
      .send(item);

    // Then
    expect(response.status).toBe(503);
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(1);
  });

  it('keeps acknowledgement alive during real PostgreSQL ENOSPC', async () => {
    // Given
    const full = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('demo_full')
      .withUsername('postgres')
      .withPassword('postgres')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=256m' })
      .start();
    const faultPool = new Pool({
      connectionString: full.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    faultPool.on('error', () => {
      /* The deliberate server failure is asserted through the HTTP contract. */
    });
    try {
      const faultDb = drizzle(faultPool, { schema });
      await migrate(faultDb, { migrationsFolder: path.join(process.cwd(), 'src/db/migrations') });
      const target = new DemoStorage(
        {
          mode: 'sample',
          databaseMaxBytes: 8 * 1024 ** 3,
          minimumFreeBytes: 0,
          capacityPath: '/capacity',
          expectedDatabase: 'demo_full',
        },
        faultDb,
        async () => {
          const result = await full.exec(['df', '-Pk', '/var/lib/postgresql/data']);
          const line = result.stdout.trim().split('\n').at(-1);
          const available = Number(line?.trim().split(/\s+/)[3]);
          if (!Number.isFinite(available)) throw new Error('Missing capacity receipt');
          return available * 1024;
        },
      );
      await target.refresh();
      expect(target.ready).toBe(true);

      // When
      const filled = await full.exec([
        'sh',
        '-c',
        'dd if=/dev/zero of=/var/lib/postgresql/data/enospc-test bs=1048576 count=256 2>&1',
      ]);
      await target.refresh();
      const app = createApp({ storage: target });
      const response = await request(app).post('/webhooks/classified-notification').send(item);
      const health = await request(app).get('/health');

      // Then
      expect(filled.exitCode).not.toBe(0);
      expect(filled.stdout).toContain('No space left on device');
      expect(response.status).toBe(200);
      expect(response.body.storage).toBe('skipped');
      expect(health.status).toBe(200);
    } finally {
      await faultPool.end();
      await full.stop();
    }
  });

  it('blocks case and slash variants of internal endpoints at public Caddy ingress', async () => {
    // Given
    const docker = promisify(execFile);
    const name = 'demo-caddy-proof-' + randomUUID();
    const directory = await mkdtemp(path.join(tmpdir(), 'demo-caddy-proof-'));
    const config = path.join(directory, 'Caddyfile');
    await copyFile('docker/caddy/Caddyfile', config);
    onTestFinished(async () => {
      const results = await Promise.allSettled([
        docker('docker', ['rm', '-f', name]),
        rm(directory, { recursive: true, force: true }),
      ]);
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const error: unknown = result.reason;
        if (
          error instanceof Error &&
          'stderr' in error &&
          typeof error.stderr === 'string' &&
          error.stderr.includes('No such container')
        )
          continue;
        throw new Error('Disposable Caddy cleanup failed', { cause: error });
      }
    });
    await docker('docker', [
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::8080',
      '-e',
      'API_DOMAIN=:8080',
      '-e',
      'METABASE_DOMAIN=:8081',
      '-e',
      'ACME_EMAIL=demo@example.com',
      '-v',
      config + ':/etc/caddy/Caddyfile:ro',
      'caddy:2-alpine',
    ]);
    const port = await docker('docker', ['port', name, '8080']);
    const base = 'http://' + port.stdout.trim();
    const deadline = performance.now() + 5000;
    let started = false;
    while (!started && performance.now() < deadline) {
      try {
        await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
        started = true;
      } catch {
        await delay(50);
      }
    }
    const control = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    expect(control.status).toBe(502);

    // When
    const responses = await Promise.all(
      ['/metrics', '/metrics/', '/METRICS/', '/ready', '/READY/'].map((uri) =>
        fetch(base + uri, { signal: AbortSignal.timeout(1000) }),
      ),
    );

    // Then
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('initializes a fresh schema through the independent maintenance runtime', async () => {
    // Given
    await db.execute(
      sql`DROP TABLE classified_images, classified_price_history, classifieds, webhook_events`,
    );
    await db.execute(sql`TRUNCATE drizzle.__drizzle_migrations`);
    const { startMaintenance } = await import('../src/maintenance.js');
    const worker = startMaintenance(0);
    const address = worker.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing maintenance address');
    const health = 'http://127.0.0.1:' + address.port + '/health';

    // When
    try {
      await expect
        .poll(async () => (await fetch(health, { signal: AbortSignal.timeout(1000) })).status, {
          timeout: 15_000,
        })
        .toBe(200);
    } finally {
      await worker.stop();
    }
    const tables = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM pg_tables WHERE schemaname='public' AND tablename IN ('webhook_events','classifieds','classified_images','classified_price_history')",
    );

    // Then
    expect(tables.rows[0]?.count).toBe('4');
  });

  it('upgrades an existing schema without resetting a healthy sample', async () => {
    // Given
    const [receipt] = await db
      .insert(schema.webhookEvents)
      .values({ bodySha256: 'upgrade-fixture' })
      .returning();
    const { startMaintenance } = await import('../src/maintenance.js');
    const worker = startMaintenance(0);
    const address = worker.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing maintenance address');

    // When
    try {
      await expect
        .poll(
          async () =>
            (
              await fetch('http://127.0.0.1:' + address.port + '/health', {
                signal: AbortSignal.timeout(1000),
              })
            ).status,
          { timeout: 15_000 },
        )
        .toBe(200);
    } finally {
      await worker.stop();
    }

    // Then
    expect((await db.select().from(schema.webhookEvents))[0]?.id).toBe(receipt?.id);
  });

  it('defers failed migrations and automatically resumes after the journal is repaired', async () => {
    // Given
    await db.execute(
      sql`ALTER TABLE drizzle.__drizzle_migrations RENAME TO fixture_saved_migrations`,
    );
    const { startMaintenance } = await import('../src/maintenance.js');
    const worker = startMaintenance(0);
    const address = worker.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing maintenance address');
    const health = 'http://127.0.0.1:' + address.port + '/health';
    let repaired = false;

    // When
    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ present: boolean }>(
                "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
              )
            ).rows[0]?.present,
          { timeout: 10_000 },
        )
        .toBe(true);
      const failed = await fetch(health, { signal: AbortSignal.timeout(1000) });
      await db.execute(sql`DROP TABLE drizzle.__drizzle_migrations`);
      await db.execute(
        sql`ALTER TABLE drizzle.fixture_saved_migrations RENAME TO __drizzle_migrations`,
      );
      repaired = true;
      await expect
        .poll(async () => (await fetch(health, { signal: AbortSignal.timeout(1000) })).status, {
          timeout: 15_000,
        })
        .toBe(200);

      // Then
      expect(failed.status).toBe(503);
    } finally {
      await worker.stop();
      if (!repaired) {
        await db.execute(sql`DROP TABLE IF EXISTS drizzle.__drizzle_migrations`);
        await db.execute(
          sql`ALTER TABLE drizzle.fixture_saved_migrations RENAME TO __drizzle_migrations`,
        );
      }
    }
  });

  it('continues acknowledging under pressure after maintenance stops', async () => {
    // Given
    const { startMaintenance } = await import('../src/maintenance.js');
    const worker = startMaintenance(0);
    await worker.stop();
    const target = storage({ databaseMaxBytes: 1 });
    await target.refresh();

    // When
    const response = await request(createApp({ storage: target }))
      .post('/webhooks/classified-notification')
      .send(item);

    // Then
    expect(response.status).toBe(200);
    expect(response.body.storage).toBe('skipped');
    expect(await db.select().from(schema.webhookEvents)).toHaveLength(0);
  });

  it('survives database restart and resumes independent maintenance', async () => {
    // Given
    const docker = promisify(execFile);
    const { startMaintenance } = await import('../src/maintenance.js');
    const worker = startMaintenance(0);
    const address = worker.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing maintenance address');
    const health = 'http://127.0.0.1:' + address.port + '/health';
    const target = storage();
    await target.refresh();
    let stopped = false;

    // When
    try {
      await expect
        .poll(async () => (await fetch(health, { signal: AbortSignal.timeout(1000) })).status, {
          timeout: 15_000,
        })
        .toBe(200);
      await docker('docker', ['stop', container.getId()]);
      stopped = true;
      const response = await request(createApp({ storage: target }))
        .post('/webhooks/classified-notification')
        .send(item);
      await expect
        .poll(async () => (await fetch(health, { signal: AbortSignal.timeout(1000) })).status, {
          timeout: 15_000,
        })
        .toBe(503);
      await docker('docker', ['start', container.getId()]);
      stopped = false;
      const mapping = await docker('docker', ['port', container.getId(), '5432/tcp']);
      // Docker reassigns an ephemeral published port after stop/start; update only this fixture endpoint.
      const resumed = new URL(container.getConnectionUri());
      resumed.port = mapping.stdout.trim().split('\n')[0]?.split(':').at(-1) ?? '';
      pool.options.connectionString = resumed.href;
      await expect
        .poll(async () => (await fetch(health, { signal: AbortSignal.timeout(1000) })).status, {
          timeout: 15_000,
        })
        .toBe(200);
      await target.refresh();

      // Then
      expect(response.status).toBe(200);
      expect(response.body.storage).toBe('skipped');
      expect(target.ready).toBe(true);
    } finally {
      if (stopped) await docker('docker', ['start', container.getId()]);
      await worker.stop();
    }
  });
});
