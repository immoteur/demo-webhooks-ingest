import { Router } from 'express';

import { WEBHOOK_EVENT_TYPES } from '../../modules/webhooks/webhook.utils.js';

export function createRootController(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'webhooks-ingest-demo',
      endpoints: {
        health: '/health',
        webhooks: WEBHOOK_EVENT_TYPES.map((t) => `/webhooks/${t}`),
      },
    });
  });

  return router;
}
