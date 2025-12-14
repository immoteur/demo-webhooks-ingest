import type { Express } from 'express';

import { createHealthController } from './controllers/health.controller.js';
import { createRootController } from './controllers/root.controller.js';
import { createImmoteurClassifiedsExportWebhookController } from './controllers/webhooks.classifieds-export.controller.js';
import { createImmoteurClassifiedNotificationWebhookController } from './controllers/webhooks.classified-notification.controller.js';
import { ipAllowList } from './middleware/ip-allowlist.js';

export function registerRoutes(app: Express, options?: { webhookAllowedIp?: string }): void {
  app.use(createRootController());
  app.use(createHealthController());

  if (options?.webhookAllowedIp) {
    app.use('/webhooks', ipAllowList(options.webhookAllowedIp));
  }

  app.use('/webhooks', createImmoteurClassifiedNotificationWebhookController());
  app.use('/webhooks', createImmoteurClassifiedsExportWebhookController());
}
