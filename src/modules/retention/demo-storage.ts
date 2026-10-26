import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';

import type { Classified } from '@immoteur/openapi-zod';
import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { webhookEvents } from '../../db/schema.js';
import { env, type DemoStorageMode } from '../../env.js';
import { mapClassifiedToUpsertDto } from '../../http/mappers/classified.mapper.js';
import { logger } from '../../logger.js';
import { writeClassifieds } from '../classifieds/classified.repository.js';
import type { WebhookEventType } from '../webhooks/webhook.utils.js';

const LOCK = 319984002;
const GIB = 1024 ** 3;
const TABLES = ['classified_images', 'classified_price_history', 'classifieds', 'webhook_events'];
const EXPECTED_FKS = [
  'classified_images.classified_id->classifieds.id',
  'classified_price_history.classified_id->classifieds.id',
  'classifieds.last_webhook_event_id->webhook_events.id',
];

export type StorageOutcome = {
  storage: 'sampled' | 'metadata-only' | 'skipped';
  reason?: 'initializing' | 'unavailable' | 'capacity' | 'rate-limit' | 'contention' | 'item-limit';
  storedItems: number;
};

export type DemoStorageSettings = {
  mode: DemoStorageMode;
  databaseMaxBytes: number;
  minimumFreeBytes: number;
  capacityPath: string;
  expectedDatabase: string;
};

export function storageSettings(): DemoStorageSettings {
  return {
    mode: env.DEMO_STORAGE_MODE,
    databaseMaxBytes: env.DEMO_DATABASE_MAX_BYTES,
    minimumFreeBytes: env.DEMO_MIN_FREE_BYTES,
    capacityPath: env.DEMO_CAPACITY_PATH,
    expectedDatabase: decodeURIComponent(new URL(env.DATABASE_URL).pathname.slice(1)),
  };
}

type Connection = Pick<typeof db, 'execute'>;
type Snapshot = {
  observedAt: number;
  freeBytes: number;
  databaseBytes: number;
  ready: boolean;
  reason: 'initializing' | 'unavailable' | 'capacity';
};

export class DemoStorage {
  private snapshot: Snapshot = {
    observedAt: 0,
    freeBytes: 0,
    databaseBytes: 0,
    ready: false,
    reason: 'initializing',
  };
  private refreshing: Promise<void> | null = null;
  private active = false;
  private nextWriteAt = 0;
  private nextReceiptAt = 0;
  private holdingReserve = false;
  private accepted = 0;
  private stored = 0;
  private skipped = 0;
  private resets = 0;
  private resetFailures = 0;
  private lastMaintenance = 0;
  private lastPrune = 0;
  private listingCount = 0;
  private receiptCount = 0;

  constructor(
    readonly settings: DemoStorageSettings = storageSettings(),
    private readonly database: typeof db = db,
    private readonly readFreeBytes: (path: string) => Promise<number> = async (path) => {
      const fs = await statfs(path, { bigint: true });
      return Number(fs.bavail * fs.bsize);
    },
  ) {}

  get mode(): DemoStorageMode {
    return this.settings.mode;
  }

  get available(): boolean {
    return this.snapshot.observedAt > 0 && this.snapshot.reason !== 'unavailable';
  }

  get ready(): boolean {
    return this.snapshot.ready && Date.now() - this.snapshot.observedAt <= 10_000;
  }

  startCapacityMonitor(): () => void {
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), 5000);
    timer.unref();
    return () => clearInterval(timer);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.observe().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async observe(): Promise<void> {
    try {
      const freeBytes = await this.readFreeBytes(this.settings.capacityPath);
      await this.verifyDataset(this.database);
      const result = await this.database.execute<{ bytes: string }>(
        sql`SELECT pg_database_size(current_database())::text AS bytes`,
      );
      const databaseBytes = Number(result.rows[0]?.bytes ?? Infinity);
      const counts = await this.database.execute<{ listings: string; receipts: string }>(sql`
        SELECT (SELECT count(*)::text FROM (SELECT 1 FROM classifieds LIMIT 1001) c) AS listings,
               (SELECT count(*)::text FROM (SELECT 1 FROM webhook_events LIMIT 1001) e) AS receipts`);
      this.listingCount = Number(counts.rows[0]?.listings ?? 0);
      this.receiptCount = Number(counts.rows[0]?.receipts ?? 0);
      if (freeBytes <= this.settings.minimumFreeBytes) this.holdingReserve = true;
      if (freeBytes > this.settings.minimumFreeBytes + 4 * GIB) this.holdingReserve = false;
      this.snapshot = {
        observedAt: Date.now(),
        freeBytes,
        databaseBytes,
        ready: !this.holdingReserve && databaseBytes < this.settings.databaseMaxBytes,
        reason: 'capacity',
      };
    } catch {
      this.snapshot = {
        ...this.snapshot,
        observedAt: Date.now(),
        ready: false,
        reason: 'unavailable',
      };
    }
  }

  private async verifyDataset(connection: Connection): Promise<void> {
    const tables = await connection.execute<{ name: string; owned: boolean; database: string }>(sql`
      SELECT c.relname AS name, pg_get_userbyid(c.relowner) = current_user AS owned,
             current_database() AS database
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('webhook_events','classifieds','classified_images','classified_price_history')`);
    if (
      tables.rows.length !== 4 ||
      tables.rows.some(
        (row) =>
          !row.owned ||
          row.database !== this.settings.expectedDatabase ||
          !TABLES.includes(row.name),
      )
    )
      throw new Error('UnexpectedDemoSchema');
    const fks = await connection.execute<{ edge: string; local: boolean }>(sql`
      SELECT source.relname || '.' || sa.attname || '->' || target.relname || '.' || ta.attname AS edge,
        sn.nspname = 'public' AND tn.nspname = 'public' AND cardinality(k.conkey) = 1 AND cardinality(k.confkey) = 1 AS local
      FROM pg_constraint k
      JOIN pg_class source ON source.oid = k.conrelid
      JOIN pg_namespace sn ON sn.oid = source.relnamespace
      JOIN pg_class target ON target.oid = k.confrelid
      JOIN pg_namespace tn ON tn.oid = target.relnamespace
      JOIN pg_attribute sa ON sa.attrelid = source.oid AND sa.attnum = k.conkey[1]
      JOIN pg_attribute ta ON ta.attrelid = target.oid AND ta.attnum = k.confkey[1]
      WHERE k.contype = 'f' AND (
        (sn.nspname = 'public' AND source.relname IN ('webhook_events','classifieds','classified_images','classified_price_history')) OR
        (tn.nspname = 'public' AND target.relname IN ('webhook_events','classifieds','classified_images','classified_price_history')))`);
    if (
      fks.rows.length !== 3 ||
      fks.rows.some((row) => !row.local || !EXPECTED_FKS.includes(row.edge))
    )
      throw new Error('UnexpectedDemoDependencies');
  }

  async canPersist(): Promise<boolean> {
    if (Date.now() - this.snapshot.observedAt > 5000) await this.refresh();
    return this.ready;
  }

  async record(input: {
    ip?: string;
    eventType: WebhookEventType;
    rawBody: string;
    items: readonly Classified[];
    notificationType: string | null;
    error: string | null;
  }): Promise<StorageOutcome> {
    this.accepted++;
    const skip = (reason: StorageOutcome['reason']): StorageOutcome => {
      this.skipped++;
      return { storage: 'skipped', reason, storedItems: 0 };
    };
    if (!this.ready) return skip(this.snapshot.reason);
    const now = Date.now();
    if (this.active || now < this.nextWriteAt || now < this.nextReceiptAt)
      return skip('rate-limit');
    const items: Classified[] = [];
    if (this.mode === 'sample') {
      for (const item of input.items) {
        if (items.length === 5) break;
        if (
          Buffer.byteLength(JSON.stringify(item)) <= 65536 &&
          (item.media?.images.length ?? 0) <= 50 &&
          (item.transaction.price.history?.length ?? 0) <= 100
        )
          items.push(item);
      }
    }
    if (this.mode === 'sample' && input.items.length > 0 && items.length === 0)
      return skip('item-limit');
    this.nextWriteAt = now + 500;
    this.active = true;
    try {
      const storedItems = await this.database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
        const lock = await tx.execute<{ acquired: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${LOCK}) AS acquired`,
        );
        if (!lock.rows[0]?.acquired) return null;
        const [receipt] = await tx
          .insert(webhookEvents)
          .values({
            requestIp: input.ip ?? null,
            eventType: input.eventType,
            bodySha256: createHash('sha256').update(input.rawBody).digest('hex'),
            payload: null,
            error: input.error?.slice(0, 256) ?? null,
          })
          .returning({ id: webhookEvents.id, receivedAt: webhookEvents.receivedAt });
        if (!receipt) throw new Error('MissingReceipt');
        await writeClassifieds(
          tx,
          items.map((classified) =>
            mapClassifiedToUpsertDto({
              provider: 'immoteur',
              classified,
              notificationType: input.notificationType,
              webhookEventId: receipt.id,
              receivedAt: receipt.receivedAt,
            }),
          ),
        );
        await this.prune(tx);
        return items.length;
      });
      if (storedItems === null) return skip('contention');
      this.nextReceiptAt = now + 1000;
      this.stored += storedItems;
      return { storage: this.mode === 'metadata-only' ? 'metadata-only' : 'sampled', storedItems };
    } catch {
      this.snapshot = { ...this.snapshot, ready: false, reason: 'unavailable' };
      return skip('unavailable');
    } finally {
      this.active = false;
    }
  }

  private async prune(connection: Connection): Promise<void> {
    await connection.execute(sql`
      DELETE FROM classifieds WHERE id IN (
        SELECT id FROM classifieds WHERE last_received_at < now() - interval '24 hours'
        UNION ALL
        SELECT id FROM (SELECT id FROM classifieds ORDER BY last_received_at DESC, id DESC OFFSET 1000) surplus
      )`);
    await connection.execute(sql`
      WITH victims AS (
        SELECT id FROM webhook_events WHERE received_at < now() - interval '12 hours'
        UNION
        SELECT id FROM (SELECT id FROM webhook_events ORDER BY received_at DESC, id DESC OFFSET 1000) surplus
      )
      DELETE FROM classifieds WHERE last_webhook_event_id IN (SELECT id FROM victims)`);
    await connection.execute(sql`
      DELETE FROM webhook_events WHERE id IN (
        SELECT id FROM webhook_events WHERE received_at < now() - interval '12 hours'
        UNION ALL
        SELECT id FROM (SELECT id FROM webhook_events ORDER BY received_at DESC, id DESC OFFSET 1000) surplus
      )`);
  }

  async maintain(): Promise<void> {
    await this.refresh();
    if (this.snapshot.reason === 'unavailable') return;
    if (this.mode === 'persist') {
      this.lastMaintenance = Date.now();
      return;
    }
    if (this.ready && Date.now() - this.lastPrune < 60_000) {
      this.lastMaintenance = Date.now();
      return;
    }
    let reset = false;
    try {
      await this.database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
        const lock = await tx.execute<{ acquired: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${LOCK}) AS acquired`,
        );
        if (!lock.rows[0]?.acquired) return;
        if (!this.ready) {
          if (this.mode !== 'sample') return;
          await tx.execute(
            sql`LOCK TABLE public.classified_images, public.classified_price_history, public.classifieds, public.webhook_events IN ACCESS EXCLUSIVE MODE NOWAIT`,
          );
          await this.verifyDataset(tx);
          const nonempty = await tx.execute<{ present: boolean }>(sql`SELECT
            EXISTS(SELECT 1 FROM webhook_events LIMIT 1) OR EXISTS(SELECT 1 FROM classifieds LIMIT 1) AS present`);
          if (nonempty.rows[0]?.present) {
            await tx.execute(
              sql`TRUNCATE TABLE public.classified_images, public.classified_price_history, public.classifieds, public.webhook_events RESTART IDENTITY`,
            );
            reset = true;
          }
        } else await this.prune(tx);
        this.lastMaintenance = Date.now();
        this.lastPrune = Date.now();
      });
      if (reset) {
        this.resets++;
        logger.warn({ reason: 'capacity' }, 'disposable demo sample reset');
      }
    } catch {
      this.resetFailures++;
      logger.warn({ errorType: 'MaintenanceDeferred' }, 'demo maintenance deferred');
    }
    await this.refresh();
  }

  metrics(): string {
    const values: Record<string, number> = {
      accepted_total: this.accepted,
      stored_items_total: this.stored,
      skipped_total: this.skipped,
      database_bytes: this.snapshot.databaseBytes,
      free_bytes: this.snapshot.freeBytes,
      storage_ready: Number(this.ready),
      capacity_observed_timestamp_seconds: this.snapshot.observedAt / 1000,
      resets_total: this.resets,
      reset_failures_total: this.resetFailures,
      maintenance_timestamp_seconds: this.lastMaintenance / 1000,
      resident_memory_bytes: process.memoryUsage().rss,
      sample_listings: this.listingCount,
      sample_receipts: this.receiptCount,
    };
    return (
      Object.entries(values)
        .map(([name, value]) => `demo_ingest_${name} ${value}`)
        .join('\n') + '\n'
    );
  }
}
