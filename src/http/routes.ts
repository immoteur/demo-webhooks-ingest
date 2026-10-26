import type { Express } from 'express';

import type { ClassifiedsExportStorageMode } from '../env.js';

import { createHealthController } from './controllers/health.controller.js';
import { createRootController } from './controllers/root.controller.js';
import { createImmoteurClassifiedsExportWebhookController } from './controllers/webhooks.classifieds-export.controller.js';
import { createImmoteurClassifiedNotificationWebhookController } from './controllers/webhooks.classified-notification.controller.js';
import { createImmoteurClassifiedNotificationBatchWebhookController } from './controllers/webhooks.classified-notification-batch.controller.js';
import { ipAllowList } from './middleware/ip-allowlist.js';
import { DemoStorage } from '../modules/retention/demo-storage.js';

export type WebhookRouteOptions = {
  webhookAllowedIp?: string;
  classifiedsExportStorageMode?: ClassifiedsExportStorageMode;
  storage?: DemoStorage;
};

export function registerRoutes(app: Express, options?: WebhookRouteOptions): void {
  const storage = options?.storage ?? new DemoStorage();
  app.use(createRootController());
  app.use(createHealthController());
  app.get('/ready', (_req, res) =>
    res.status(storage.ready ? 200 : 503).json({ ready: storage.ready }),
  );
  app.get('/metrics', (_req, res) =>
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(storage.metrics()),
  );

  if (options?.webhookAllowedIp) {
    app.use('/webhooks', ipAllowList(options.webhookAllowedIp));
  }

  let activeWebhooks = 0;
  app.use('/webhooks', (_req, res, next) => {
    if (activeWebhooks >= 8) {
      res.setHeader('Retry-After', '1');
      res.status(429).json({ ok: false });
      return;
    }
    activeWebhooks++;
    res.once('close', () => {
      activeWebhooks--;
    });
    next();
  });

  app.use('/webhooks', createImmoteurClassifiedNotificationWebhookController(storage));
  app.use('/webhooks', createImmoteurClassifiedNotificationBatchWebhookController(storage));
  app.use(
    '/webhooks',
    createImmoteurClassifiedsExportWebhookController(
      options?.classifiedsExportStorageMode ?? 'persist',
      storage,
    ),
  );
}
