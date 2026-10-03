import express, { Router } from 'express';
import { z } from 'zod';
import { Classified } from '@immoteur/openapi-zod';

import { mapClassifiedToUpsertDto } from '../mappers/classified.mapper.js';
import { upsertClassifieds } from '../../modules/classifieds/classified.repository.js';
import { ingestWebhook } from '../../modules/webhooks/webhook-ingest.service.js';
import { safeJsonParse } from '../../modules/webhooks/webhook.utils.js';

const batchSchema = z
  .strictObject({
    items: z.array(Classified).min(1).max(10),
  })
  .refine(({ items }) => new Set(items.map((item) => item.id)).size === items.length);

const headersSchema = z.object({
  serviceId: z.uuid(),
  eventId: z.uuid(),
  deliveryId: z.uuid(),
  timestamp: z.string().regex(/^\d+$/),
  userAgent: z.string().trim().min(1),
});

export function createImmoteurClassifiedNotificationBatchWebhookController(): Router {
  const router = Router();
  router.use(express.raw({ type: '*/*', limit: '10mb' }));
  router.post('/classified-notification-batch', async (req, res) => {
    const headers = headersSchema.safeParse({
      serviceId: req.get('X-Immoteur-Service-Id'),
      eventId: req.get('X-Immoteur-Event-Id'),
      deliveryId: req.get('X-Immoteur-Delivery-Id'),
      timestamp: req.get('X-Immoteur-Timestamp'),
      userAgent: req.get('User-Agent'),
    });
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    const json = safeJsonParse(rawBody);
    const body = json.success ? batchSchema.safeParse(json.data) : null;
    if (!headers.success || !body?.success) {
      res.status(400).json({ ok: false });
      return;
    }

    const correlation = {
      serviceId: headers.data.serviceId,
      eventId: headers.data.eventId,
      deliveryId: headers.data.deliveryId,
    };
    const ingested = await ingestWebhook<z.infer<typeof batchSchema>>({
      defaultEventType: 'classified-notification-batch',
      rawBody,
      ip: req.ip,
      persistPayload: true,
      schema: batchSchema,
    });
    if (!ingested.ok || !ingested.webhookEventId || !ingested.receivedAt) {
      const error = ingested.ok ? null : ingested.error;
      req.log?.error(
        {
          ...correlation,
          itemCount: body.data.items.length,
          errorType: ingested.ok
            ? 'MissingReceipt'
            : error instanceof Error
              ? error.name
              : 'UnknownError',
          causeType:
            error instanceof Error && error.cause instanceof Error ? error.cause.name : null,
        },
        'failed to store batch webhook event',
      );
      res.status(500).json({ ok: false });
      return;
    }

    const webhookEventId = ingested.webhookEventId;
    const receivedAt = ingested.receivedAt;
    const upsert = await upsertClassifieds(
      body.data.items.map((classified) =>
        mapClassifiedToUpsertDto({
          provider: 'immoteur',
          classified,
          notificationType: null,
          webhookEventId,
          receivedAt,
        }),
      ),
    );
    if (!upsert.ok || upsert.failures.length > 0) {
      req.log?.error(
        { ...correlation, itemCount: body.data.items.length },
        'failed to persist batch',
      );
      res.status(500).json({ ok: false });
      return;
    }
    req.log?.info(
      { ...correlation, webhookEventId, itemCount: body.data.items.length },
      'processed batch webhook',
    );
    res.status(200).json({ ok: true, duplicate: ingested.duplicate });
  });
  return router;
}
