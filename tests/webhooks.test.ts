import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  classifiedImages,
  classifiedPriceHistory,
  classifieds,
  webhookEvents,
} from '../src/db/schema.js';

type JsonObject = Record<string, unknown>;

type ClassifiedNotificationImage = JsonObject & {
  id?: string;
  position?: number;
  url?: string;
  averageHash?: string | null;
  differenceHash?: string | null;
  perceptualHash?: string | null;
};

type ClassifiedNotificationPriceHistoryEntry = JsonObject & {
  timestamp?: string;
  value?: number;
};

type ClassifiedNotificationPayload = JsonObject & {
  id: string;
  type?: string;
  meta?: JsonObject & {
    firstSeenAt?: string;
    lastModifiedAt?: string;
    lastSeenAt?: string;
    removedAt?: string | null;
  };
  media?: JsonObject & {
    images?: ClassifiedNotificationImage[];
  };
  transaction?: JsonObject & {
    price?: JsonObject & {
      current?: number;
      history?: ClassifiedNotificationPriceHistoryEntry[];
    };
  };
};

function getPgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;

  for (let i = 0; i < 5; i += 1) {
    if (!current || typeof current !== 'object') return undefined;

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;

    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) return undefined;
    current = cause;
  }

  return undefined;
}

describe('webhook ingestion', () => {
  let container: StartedPostgreSqlContainer;
  let app: Express;
  let db: NodePgDatabase;
  let pool: Pool;
  let classifiedNotificationExample: Record<string, unknown>;
  let classifiedsExportExample: Record<string, unknown>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('webhooks_test')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    process.env.DATABASE_URL = container.getConnectionUri();

    const client = await import('../src/db/client.js');
    db = client.db as unknown as NodePgDatabase;
    pool = client.pool as unknown as Pool;

    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'src', 'db', 'migrations') });

    const { createApp } = await import('../src/server.js');
    app = createApp();

    const openapiYaml = await readFile(path.join(process.cwd(), 'openapi.yaml'), 'utf8');
    const openapi = YAML.parse(openapiYaml);
    const example =
      openapi?.webhooks?.['classified-notification']?.post?.requestBody?.content?.[
        'application/json'
      ]?.example;

    if (!example || typeof example !== 'object') {
      throw new Error('Missing OpenAPI example for webhooks.classified-notification');
    }

    classifiedNotificationExample = example as Record<string, unknown>;

    const exportExample =
      openapi?.webhooks?.['classifieds']?.post?.requestBody?.content?.['application/json']?.example;

    if (!exportExample || typeof exportExample !== 'object') {
      throw new Error('Missing OpenAPI example for webhooks.classifieds');
    }

    classifiedsExportExample = exportExample as Record<string, unknown>;
  });

  beforeEach(async () => {
    await db.delete(classifieds);
    await db.delete(webhookEvents);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('stores a webhook event row', async () => {
    // Given
    const id = '7f6e3b4d-9c22-46a0-8f20-0d1a2b3c4d5e';
    const body = { id, type: 'created' };

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('classified-notification');
    expect(rows[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.payload).not.toBeNull();
    expect(rows[0]?.error).toMatch(/^schema_invalid:/);
  });

  it('stores a valid payload with no error', async () => {
    // Given
    const requestId = 'req_123';
    const forwardedFor = '203.0.113.10';

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer should-not-be-stored')
      .set('cookie', 'a=b')
      .set('x-request-id', requestId)
      .set('x-forwarded-for', forwardedFor)
      .send(classifiedNotificationExample);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.eventType).toBe('classified-notification');
    expect(row.error).toBeNull();
    expect((row.payload as Record<string, unknown>).id).toBe(classifiedNotificationExample.id);
    expect((row.payload as Record<string, unknown>).type).toBe(classifiedNotificationExample.type);
    expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('upserts a classifieds row with flattened columns', async () => {
    // Given
    const id = classifiedNotificationExample.id as string;
    const exampleImages =
      ((classifiedNotificationExample.media as { images?: unknown } | undefined)?.images as
        | unknown[]
        | undefined) ?? [];
    const examplePriceHistory =
      ((
        (classifiedNotificationExample.transaction as { price?: unknown } | undefined)?.price as
          | { history?: unknown }
          | undefined
      )?.history as unknown[] | undefined) ?? [];

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(classifiedNotificationExample);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);

    const classifiedRows = await db.select().from(classifieds).where(eq(classifieds.id, id));
    expect(classifiedRows).toHaveLength(1);

    const row = classifiedRows[0]!;
    expect(row.provider).toBe('immoteur');
    expect(row.lastWebhookEventId).toBe(eventRows[0]!.id);
    expect(row.currency).toBe('euro');
    expect(row.locationDepartment).toBe('75');
    expect(row.propertyType).toBe('apartment');
    expect(row.transactionType).toBe('sale');
    expect(row.transactionPriceCurrent).toBeTypeOf('number');

    const imageRows = await db
      .select()
      .from(classifiedImages)
      .where(eq(classifiedImages.classifiedId, id));
    expect(imageRows.length).toBe(exampleImages.length);
    if (imageRows.length > 0) {
      expect(imageRows[0]!.url).toMatch(/^https?:\/\//);
    }

    const priceHistoryRows = await db
      .select()
      .from(classifiedPriceHistory)
      .where(eq(classifiedPriceHistory.classifiedId, id));
    expect(priceHistoryRows.length).toBe(examplePriceHistory.length);
  });

  it('stores a classifieds export webhook and upserts all items', async () => {
    // Given
    const items = (classifiedsExportExample.items as unknown[]) ?? [];
    const firstItem = (items[0] as { id?: unknown } | undefined) ?? {};
    const firstItemId = firstItem.id as string;

    // When
    const res = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.eventType).toBe('classifieds-export');
    expect(eventRows[0]!.error).toBeNull();

    if (firstItemId) {
      const classifiedRows = await db
        .select()
        .from(classifieds)
        .where(eq(classifieds.id, firstItemId));
      expect(classifiedRows).toHaveLength(1);
      expect(classifiedRows[0]!.lastWebhookEventId).toBe(eventRows[0]!.id);
    }
  });

  it('stores multiple export events for repeated payloads', async () => {
    // When
    const res1 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);
    const res2 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(classifiedsExportExample);

    // Then
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ ok: true, duplicate: false });
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ ok: true, duplicate: false });

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(2);
  });

  it('stores schema_invalid for malformed export payloads', async () => {
    // Given
    const body = { exportId: '2f9b734d-9c22-46a0-8f20-0d1a2b3c4d5e', items: [{}] };

    // When
    const res = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const eventRows = await db.select().from(webhookEvents);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]!.error).toMatch(/^schema_invalid:/);

    const classifiedRows = await db.select().from(classifieds);
    expect(classifiedRows).toHaveLength(0);
  });

  it('only exposes the classified webhook route', async () => {
    // Given
    const body = {};

    // When
    const res1 = await request(app)
      .post('/webhooks/property-notification')
      .set('content-type', 'application/json')
      .send(body);
    const res2 = await request(app)
      .post('/webhooks/classifieds')
      .set('content-type', 'application/json')
      .send(body);
    const res3 = await request(app)
      .post('/webhooks/classifieds-export')
      .set('content-type', 'application/json')
      .send({ exportId: '2f9b734d-9c22-46a0-8f20-0d1a2b3c4d5e', items: [] });

    // Then
    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
    expect(res3.status).toBe(200);
  });

  it('stores audit body hash even when JSON is invalid', async () => {
    // Given
    const raw = '{"id":';

    // When
    const res = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(raw);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bodySha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(rows[0]?.error).toMatch(/^invalid_json:/);
  });

  it('rejects requests when webhook IP allowlist does not match', async () => {
    // Given
    const { createApp } = await import('../src/server.js');
    const blockedApp = createApp({ webhookAllowedIp: '10.0.0.1' });
    const body = { id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', type: 'created' };

    // When
    const res = await request(blockedApp)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(403);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(0);
  });

  it('accepts requests when webhook IP allowlist matches', async () => {
    // Given
    const { createApp } = await import('../src/server.js');
    const allowedApp = createApp({ webhookAllowedIp: '127.0.0.1' });

    const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const body = { id, type: 'created' };

    // When
    const res = await request(allowedApp)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res.status).toBe(200);

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores multiple events for the same classified id', async () => {
    // Given
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const body = { id, type: 'created' };

    // When
    const res1 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);
    const res2 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(body);

    // Then
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ ok: true });
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ ok: true });

    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(2);
  });

  it('replaces images and price history on subsequent notifications', async () => {
    // Given
    const id = classifiedNotificationExample.id as string;

    const payload1 = structuredClone(
      classifiedNotificationExample,
    ) as ClassifiedNotificationPayload;
    const payload2 = structuredClone(
      classifiedNotificationExample,
    ) as ClassifiedNotificationPayload;

    const originalImageId = payload1.media?.images?.[0]?.id;
    const originalHistoryTimestamp = payload1.transaction?.price?.history?.[0]?.timestamp;

    const media2 = (payload2.media ?? {}) as NonNullable<ClassifiedNotificationPayload['media']>;
    media2.images = [
      {
        ...(payload1.media?.images?.[0] ?? {}),
        id: '11111111-1111-1111-8111-111111111111',
        position: 1,
        url: 'https://example.com/new.jpg',
      },
    ];
    payload2.media = media2;

    const transaction2 = (payload2.transaction ?? {}) as NonNullable<
      ClassifiedNotificationPayload['transaction']
    >;
    const price2 = (transaction2.price ?? {}) as NonNullable<
      NonNullable<ClassifiedNotificationPayload['transaction']>['price']
    >;
    price2.current = 640000;
    price2.history = [
      {
        ...(payload1.transaction?.price?.history?.[0] ?? {}),
        timestamp: '2025-09-16T09:00:00Z',
        value: 640000,
      },
    ];
    transaction2.price = price2;
    payload2.transaction = transaction2;

    const meta2 = (payload2.meta ?? {}) as NonNullable<ClassifiedNotificationPayload['meta']>;
    meta2.lastModifiedAt = '2025-09-16T09:00:00Z';
    meta2.lastSeenAt = '2025-09-16T09:00:00Z';
    payload2.meta = meta2;

    // When
    const res1 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(payload1);
    const eventRowsAfter1 = await db.select().from(webhookEvents);
    const res2 = await request(app)
      .post('/webhooks/classified-notification')
      .set('content-type', 'application/json')
      .send(payload2);

    // Then
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    expect(eventRowsAfter1).toHaveLength(1);
    const firstEventId = eventRowsAfter1[0]!.id;

    const eventRowsAfter2 = await db.select().from(webhookEvents);
    expect(eventRowsAfter2).toHaveLength(2);

    const secondEventId = eventRowsAfter2.find((row) => row.id !== firstEventId)?.id;
    expect(secondEventId).toBeTruthy();

    const classifiedRow = (await db.select().from(classifieds).where(eq(classifieds.id, id)))[0]!;
    expect(classifiedRow.lastWebhookEventId).toBe(secondEventId);
    expect(classifiedRow.transactionPriceCurrent).toBe(640000);

    const imageRows = await db
      .select()
      .from(classifiedImages)
      .where(eq(classifiedImages.classifiedId, id));
    expect(imageRows).toHaveLength(1);
    expect(imageRows[0]!.id).toBe('11111111-1111-1111-8111-111111111111');
    if (originalImageId) {
      expect(imageRows.find((img) => img.id === originalImageId)).toBeUndefined();
    }

    const priceHistoryRows = await db
      .select()
      .from(classifiedPriceHistory)
      .where(eq(classifiedPriceHistory.classifiedId, id));
    expect(priceHistoryRows).toHaveLength(1);
    if (originalHistoryTimestamp) {
      expect(
        priceHistoryRows.find(
          (h) => h.timestamp.toISOString() === new Date(originalHistoryTimestamp).toISOString(),
        ),
      ).toBeUndefined();
    }
  });

  it('enforces foreign keys for classifieds child tables', async () => {
    // Given
    const classifiedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // When
    let imagesErrorCode: string | undefined;
    try {
      await db.insert(classifiedImages).values({
        classifiedId,
        id: '11111111-1111-1111-1111-111111111111',
        position: 1,
        url: 'https://example.com/1.jpg',
        averageHash: null,
        differenceHash: null,
        perceptualHash: null,
      });
    } catch (err) {
      imagesErrorCode = getPgErrorCode(err);
    }

    let priceHistoryErrorCode: string | undefined;
    try {
      await db.insert(classifiedPriceHistory).values({
        classifiedId,
        timestamp: new Date('2025-09-15T09:00:00Z'),
        value: 650000,
      });
    } catch (err) {
      priceHistoryErrorCode = getPgErrorCode(err);
    }

    // Then
    expect(imagesErrorCode).toBe('23503');
    expect(priceHistoryErrorCode).toBe('23503');
  });
});
