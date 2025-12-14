import { db } from '../../db/client.js';
import { webhookEvents } from '../../db/schema.js';
import type { WebhookEventType } from './webhook.utils.js';

export async function storeWebhookEvent(input: {
  eventType: WebhookEventType;
  receivedAt?: Date;
  requestIp: string | null;
  payload: unknown | null;
  bodySha256: string;
  error: string | null;
}): Promise<
  | { ok: true; duplicate: boolean; id: string | null; receivedAt: Date | null }
  | { ok: false; error: unknown }
> {
  try {
    const rows = await db
      .insert(webhookEvents)
      .values({
        eventType: input.eventType,
        requestIp: input.requestIp,
        payload: input.payload,
        bodySha256: input.bodySha256,
        error: input.error,
      })
      .returning({ id: webhookEvents.id, receivedAt: webhookEvents.receivedAt });

    const row = rows[0];
    return { ok: true, duplicate: false, id: row?.id ?? null, receivedAt: row?.receivedAt ?? null };
  } catch (err) {
    return { ok: false, error: err };
  }
}
