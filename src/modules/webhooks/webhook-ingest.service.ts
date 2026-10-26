import { createHash } from 'node:crypto';

import type { Classified } from '@immoteur/openapi-zod';
import type { DemoStorage, StorageOutcome } from '../retention/demo-storage.js';

import { storeWebhookEvent } from './webhook-event.repository.js';
import { extractNotificationType, safeJsonParse, type WebhookEventType } from './webhook.utils.js';

export async function ingestWebhook<TParsed>(input: {
  defaultEventType: WebhookEventType;
  rawBody: string;
  ip: string | undefined;
  persistPayload: boolean;
  storage?: DemoStorage;
  selectItems?: (parsed: TParsed) => readonly Classified[];
  schema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
}): Promise<
  | {
      ok: true;
      duplicate: boolean;
      webhookEventId: string | null;
      receivedAt: Date | null;
      parsed: TParsed | null;
      notificationType: string | null;
      storage?: StorageOutcome;
    }
  | { ok: false; error: unknown; statusCode?: number }
> {
  const jsonResult = safeJsonParse(input.rawBody);
  const bodySha256 = createHash('sha256').update(input.rawBody, 'utf8').digest('hex');

  let payload: unknown | null = null;
  let error: string | null = null;

  let notificationType: string | null = null;
  let parsed: TParsed | null = null;

  if (!jsonResult.success) {
    error = input.persistPayload ? `invalid_json: ${jsonResult.error}` : 'invalid_json';
  } else {
    payload = jsonResult.data;
    const schemaResult = input.schema.safeParse(jsonResult.data);
    if (!schemaResult.success) {
      error = input.persistPayload ? 'schema_invalid: validation failed' : 'schema_invalid';
    } else {
      parsed = schemaResult.data as TParsed;
    }

    if (jsonResult.data && typeof jsonResult.data === 'object' && !Array.isArray(jsonResult.data)) {
      const record = jsonResult.data as Record<string, unknown>;
      notificationType = extractNotificationType(record);
    }
  }

  if (input.storage && input.storage.mode !== 'persist') {
    const storage = await input.storage.record({
      ip: input.ip,
      eventType: input.defaultEventType,
      rawBody: input.rawBody,
      items: parsed && input.selectItems ? input.selectItems(parsed) : [],
      notificationType,
      error: error ? (jsonResult.success ? 'schema_invalid' : 'invalid_json') : null,
    });
    return {
      ok: true,
      duplicate: false,
      webhookEventId: null,
      receivedAt: null,
      parsed,
      notificationType,
      storage,
    };
  }
  if (input.storage && !(await input.storage.canPersist())) {
    return { ok: false, error: new Error('StorageUnavailable'), statusCode: 503 };
  }

  const result = await storeWebhookEvent({
    eventType: input.defaultEventType,
    requestIp: input.ip ?? null,
    payload: input.persistPayload ? payload : null,
    bodySha256,
    error: error?.slice(0, 256) ?? null,
  });

  if (!result.ok) return { ok: false, error: result.error, statusCode: input.storage ? 503 : 500 };

  return {
    ok: true,
    duplicate: result.duplicate,
    webhookEventId: result.id,
    receivedAt: result.receivedAt,
    parsed,
    notificationType,
  };
}
