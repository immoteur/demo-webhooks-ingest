import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as DbClient from '../src/db/client.js';
import { classifieds, webhookEvents } from '../src/db/schema.js';

type Db = typeof DbClient.db;
type DbPool = typeof DbClient.pool;

describe('retention job', () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let pool: DbPool;
  let runRetentionOnce: (options?: { now?: Date }) => Promise<{
    deletedWebhookEvents: number;
    deletedClassifieds: number;
  }>;
  let pruneWebhookPayloadsToByteBudget: () => Promise<number>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('webhooks_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.WEBHOOK_EVENTS_RETENTION_HOURS = '24';
    process.env.CLASSIFIEDS_LAST_SEEN_RETENTION_DAYS = '7';
    process.env.WEBHOOK_PAYLOAD_RETENTION_MAX_BYTES = '300';

    const client = await import('../src/db/client.js');
    db = client.db;
    pool = client.pool;

    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src', 'db', 'migrations') });

    ({ runRetentionOnce, pruneWebhookPayloadsToByteBudget } =
      await import('../src/modules/retention/retention.job.js'));
  });

  beforeEach(async () => {
    await db.delete(classifieds);
    await db.delete(webhookEvents);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('deletes old classifieds and old unreferenced webhook events', async () => {
    const now = new Date('2025-01-10T12:00:00.000Z');

    const webhookOldUnreferencedId = '00000000-0000-0000-8000-000000000001';
    const webhookOldReferencedId = '00000000-0000-0000-8000-000000000002';
    const webhookNewId = '00000000-0000-0000-8000-000000000003';

    await db.insert(webhookEvents).values([
      {
        id: webhookOldUnreferencedId,
        receivedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
        bodySha256: 'a'.repeat(64),
      },
      {
        id: webhookOldReferencedId,
        receivedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
        bodySha256: 'b'.repeat(64),
      },
      {
        id: webhookNewId,
        receivedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
        bodySha256: 'c'.repeat(64),
      },
    ]);

    await db.insert(classifieds).values([
      {
        id: '10000000-0000-0000-8000-000000000001',
        provider: 'immoteur',
        lastWebhookEventId: webhookOldReferencedId,
        lastReceivedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),

        propertyId: '20000000-0000-0000-8000-000000000001',
        currency: 'euro',
        squareUnit: 'm2',
        statusCurrent: 'active',
        metaFirstSeenAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
        metaLastModifiedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
        metaLastSeenAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),

        sourceDomain: 'example.com',
        sourceUrl: 'https://example.com/1',

        publisherIsProfessional: false,

        locationCityName: 'Paris',
        locationCityInseeCode: '75056',
        locationCountry: 'FR',
        locationDepartment: '75',
        locationPostcode: '75001',

        propertyType: 'apartment',

        transactionType: 'sale',
        transactionPriceCurrent: 100_000,
        transactionPriceInitial: 100_000,
      },
      {
        id: '10000000-0000-0000-8000-000000000002',
        provider: 'immoteur',
        lastWebhookEventId: webhookNewId,
        lastReceivedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),

        propertyId: '20000000-0000-0000-8000-000000000002',
        currency: 'euro',
        squareUnit: 'm2',
        statusCurrent: 'active',
        metaFirstSeenAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
        metaLastModifiedAt: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000),
        metaLastSeenAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),

        sourceDomain: 'example.com',
        sourceUrl: 'https://example.com/2',

        publisherIsProfessional: false,

        locationCityName: 'Paris',
        locationCityInseeCode: '75056',
        locationCountry: 'FR',
        locationDepartment: '75',
        locationPostcode: '75001',

        propertyType: 'apartment',

        transactionType: 'sale',
        transactionPriceCurrent: 200_000,
        transactionPriceInitial: 200_000,
      },
    ]);

    const res = await runRetentionOnce({ now });

    expect(res.deletedClassifieds).toBe(1);
    expect(res.deletedWebhookEvents).toBe(1);

    const remainingClassifieds = await db.select().from(classifieds);
    expect(remainingClassifieds).toHaveLength(1);
    expect(remainingClassifieds[0]!.id).toBe('10000000-0000-0000-8000-000000000001');

    const remainingWebhookEvents = await db.select().from(webhookEvents);
    expect(remainingWebhookEvents.map((r) => r.id).sort()).toEqual(
      [webhookOldReferencedId, webhookNewId].sort(),
    );
  });

  it('clears oldest payloads while preserving webhook event metadata', async () => {
    // Given
    const receivedAt = new Date('2025-01-10T12:00:00.000Z');
    const ids = Array.from(
      { length: 501 },
      (_, index) => `00000000-0000-0000-8000-${String(index + 11).padStart(12, '0')}`,
    );
    await db.insert(webhookEvents).values(
      ids.map((id, index) => ({
        id,
        receivedAt: new Date(receivedAt.getTime() + index * 1000),
        bodySha256: String.fromCharCode(97 + (index % 26)).repeat(64),
        payload: { marker: id, body: 'x'.repeat(180) },
      })),
    );

    // When
    const cleared = await pruneWebhookPayloadsToByteBudget();

    // Then
    expect(cleared).toBe(500);
    const rows = await db.select().from(webhookEvents).orderBy(webhookEvents.receivedAt);
    expect(rows).toHaveLength(501);
    expect(rows.slice(0, 500).every((row) => row.payload === null)).toBe(true);
    expect(rows[500]?.payload).toEqual(expect.anything());
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.map((row) => row.bodySha256)).toEqual(
      ids.map((_, index) => String.fromCharCode(97 + (index % 26)).repeat(64)),
    );
    const payloadBytes = await db.execute<{ retained_bytes: string }>(sql`
      SELECT coalesce(sum(octet_length(payload::text)), 0)::bigint AS retained_bytes
      FROM webhook_events
      WHERE payload IS NOT NULL
    `);
    expect(Number(payloadBytes.rows[0]?.retained_bytes ?? '0')).toBeLessThanOrEqual(300);
  });

  it('defers a payload sweep while another sweep owns the advisory lock', async () => {
    // Given
    const lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock(319984001)');

    try {
      // When
      const cleared = await pruneWebhookPayloadsToByteBudget();

      // Then
      expect(cleared).toBe(0);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(319984001)');
      lockClient.release();
    }
  });

  it('defers legacy webhook-event cleanup while a payload sweep owns the advisory lock', async () => {
    // Given
    const now = new Date('2025-01-10T12:00:00.000Z');
    const eventId = '00000000-0000-0000-8000-000000000999';
    await db.insert(webhookEvents).values({
      id: eventId,
      receivedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      bodySha256: 'z'.repeat(64),
    });
    const lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock(319984001)');

    try {
      // When
      const result = await runRetentionOnce({ now });

      // Then
      expect(result.deletedWebhookEvents).toBe(0);
      expect((await db.select().from(webhookEvents)).map((row) => row.id)).toContain(eventId);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(319984001)');
      lockClient.release();
    }
  });
});
