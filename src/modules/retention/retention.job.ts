import { asc, isNotNull, sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { webhookEvents } from '../../db/schema.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS = 15 * 60 * 1000;
const WEBHOOK_PAYLOAD_RETENTION_BATCH_SIZE = 500;
const WEBHOOK_EVENT_RETENTION_LOCK_KEY = 319984001;

export async function runRetentionOnce(options?: { now?: Date }): Promise<{
  deletedWebhookEvents: number;
  deletedClassifieds: number;
}> {
  const now = options?.now ?? new Date();

  const [deletedClassifieds, deletedWebhookEvents] = await Promise.all([
    (async () => {
      const deleted = await deleteOldClassifieds(now);
      const pruned = await pruneClassifiedsToMaxRows();
      return deleted + pruned;
    })(),
    runWebhookEventRetentionOnce(now),
  ]);

  return {
    deletedWebhookEvents,
    deletedClassifieds,
  };
}

export async function pruneWebhookPayloadsToByteBudget(): Promise<number> {
  let cleared = 0;
  while (true) {
    const batch = await db.transaction(async (tx) => {
      if (!(await acquireWebhookEventRetentionLock(tx))) return { cleared: 0, continue: false };

      const total = await tx.execute<{ retained_bytes: string }>(sql`
        SELECT coalesce(sum(octet_length(payload::text)), 0)::bigint AS retained_bytes
        FROM webhook_events
        WHERE payload IS NOT NULL
      `);
      let excessBytes =
        Number(total.rows[0]?.retained_bytes ?? '0') - env.WEBHOOK_PAYLOAD_RETENTION_MAX_BYTES;
      if (excessBytes <= 0) return { cleared: 0, continue: false };

      const candidates = await tx
        .select({
          id: webhookEvents.id,
          payloadBytes: sql<number>`octet_length(${webhookEvents.payload}::text)`,
        })
        .from(webhookEvents)
        .where(isNotNull(webhookEvents.payload))
        .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.id))
        .limit(WEBHOOK_PAYLOAD_RETENTION_BATCH_SIZE)
        .for('update');
      if (candidates.length === 0) return { cleared: 0, continue: false };

      const victims: string[] = [];
      for (const candidate of candidates) {
        victims.push(candidate.id);
        excessBytes -= candidate.payloadBytes;
        if (excessBytes <= 0) break;
      }

      await tx
        .update(webhookEvents)
        .set({ payload: null })
        .where(
          sql`${webhookEvents.id} IN (${sql.join(
            victims.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      return { cleared: victims.length, continue: excessBytes > 0 };
    });
    cleared += batch.cleared;
    if (!batch.continue) return cleared;
  }
}

export function startRetentionJob(options?: { intervalMs?: number }): { stop: () => void } {
  const intervalMs = options?.intervalMs ?? ONE_HOUR_MS;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const res = await runRetentionOnce();
      if (res.deletedClassifieds > 0 || res.deletedWebhookEvents > 0) {
        logger.info(res, 'retention cleanup done');
      }
    } catch (err) {
      logger.error({ err }, 'retention cleanup failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

export function startWebhookPayloadRetentionJob(options?: { intervalMs?: number }): {
  stop: () => void;
} {
  const intervalMs = options?.intervalMs ?? WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;

    try {
      const cleared = await pruneWebhookPayloadsToByteBudget();
      if (cleared > 0) logger.info({ cleared }, 'webhook payload retention cleanup done');
    } catch (err) {
      logger.error({ err }, 'webhook payload retention cleanup failed');
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

async function deleteOldClassifieds(now: Date): Promise<number> {
  if (env.CLASSIFIEDS_LAST_SEEN_RETENTION_DAYS <= 0) return 0;
  const cutoff = new Date(
    now.getTime() - env.CLASSIFIEDS_LAST_SEEN_RETENTION_DAYS * 24 * ONE_HOUR_MS,
  );

  const result = await db.execute<{ deleted: number }>(sql`
    WITH deleted AS (
      DELETE FROM "classifieds"
      WHERE "meta_last_seen_at" < ${cutoff}
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);

  return result.rows[0]?.deleted ?? 0;
}

async function runWebhookEventRetentionOnce(now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    if (!(await acquireWebhookEventRetentionLock(tx))) return 0;
    const deleted = await deleteOldWebhookEvents(now, tx);
    const pruned = await pruneWebhookEventsToMaxRows(tx);
    return deleted + pruned;
  });
}

async function acquireWebhookEventRetentionLock(tx: {
  execute: typeof db.execute;
}): Promise<boolean> {
  const lock = await tx.execute<{ acquired: boolean }>(sql`
    SELECT pg_try_advisory_xact_lock(${WEBHOOK_EVENT_RETENTION_LOCK_KEY}) AS acquired
  `);
  return lock.rows[0]?.acquired ?? false;
}

async function deleteOldWebhookEvents(
  now: Date,
  executor: { execute: typeof db.execute } = db,
): Promise<number> {
  if (env.WEBHOOK_EVENTS_RETENTION_HOURS <= 0) return 0;
  const cutoff = new Date(now.getTime() - env.WEBHOOK_EVENTS_RETENTION_HOURS * ONE_HOUR_MS);

  const result = await executor.execute<{ deleted: number }>(sql`
    WITH deleted AS (
      DELETE FROM "webhook_events" we
      WHERE we."received_at" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM "classifieds" c
          WHERE c."last_webhook_event_id" = we."id"
        )
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);

  return result.rows[0]?.deleted ?? 0;
}

async function pruneClassifiedsToMaxRows(): Promise<number> {
  if (env.CLASSIFIEDS_MAX_ROWS <= 0) return 0;

  const result = await db.execute<{ deleted: number }>(sql`
    WITH victims AS (
      SELECT c."id"
      FROM "classifieds" c
      ORDER BY c."last_received_at" DESC, c."id" DESC
      OFFSET ${env.CLASSIFIEDS_MAX_ROWS}
    ),
    deleted AS (
      DELETE FROM "classifieds" c
      WHERE c."id" IN (SELECT "id" FROM victims)
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);

  return result.rows[0]?.deleted ?? 0;
}

async function pruneWebhookEventsToMaxRows(
  executor: { execute: typeof db.execute } = db,
): Promise<number> {
  if (env.WEBHOOK_EVENTS_MAX_ROWS <= 0) return 0;

  const result = await executor.execute<{ deleted: number }>(sql`
    WITH victims AS (
      SELECT we."id"
      FROM "webhook_events" we
      WHERE NOT EXISTS (
        SELECT 1
        FROM "classifieds" c
        WHERE c."last_webhook_event_id" = we."id"
      )
      ORDER BY we."received_at" DESC, we."id" DESC
      OFFSET ${env.WEBHOOK_EVENTS_MAX_ROWS}
    ),
    deleted AS (
      DELETE FROM "webhook_events" we
      WHERE we."id" IN (SELECT "id" FROM victims)
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted
  `);

  return result.rows[0]?.deleted ?? 0;
}
