import { sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { env } from '../../env.js';
import { logger } from '../../logger.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function runRetentionOnce(options?: { now?: Date }): Promise<{
  deletedWebhookEvents: number;
  deletedClassifieds: number;
}> {
  const now = options?.now ?? new Date();

  const deletedClassifieds = await deleteOldClassifieds(now);
  const deletedWebhookEvents = await deleteOldWebhookEvents(now);

  return { deletedWebhookEvents, deletedClassifieds };
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

async function deleteOldWebhookEvents(now: Date): Promise<number> {
  if (env.WEBHOOK_EVENTS_RETENTION_HOURS <= 0) return 0;
  const cutoff = new Date(now.getTime() - env.WEBHOOK_EVENTS_RETENTION_HOURS * ONE_HOUR_MS);

  const result = await db.execute<{ deleted: number }>(sql`
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
