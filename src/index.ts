import 'dotenv/config';

import { createApp } from './server.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { startRetentionJob } from './modules/retention/retention.job.js';

const app = createApp({ webhookAllowedIp: env.WEBHOOK_ALLOWED_IP });

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'server started');
});

startRetentionJob();
