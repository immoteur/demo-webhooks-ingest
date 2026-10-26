import 'dotenv/config';

import { createApp } from './server.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { DemoStorage } from './modules/retention/demo-storage.js';

const storage = new DemoStorage();
const app = createApp({
  webhookAllowedIp: env.WEBHOOK_ALLOWED_IP,
  classifiedsExportStorageMode: env.CLASSIFIEDS_EXPORT_STORAGE_MODE,
  storage,
});

if (process.env.CLASSIFIEDS_EXPORT_STORAGE_MODE)
  logger.warn('CLASSIFIEDS_EXPORT_STORAGE_MODE is deprecated; set DEMO_STORAGE_MODE explicitly');
const stopCapacityMonitor = storage.startCapacityMonitor();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      classifiedsExportStorageMode: env.CLASSIFIEDS_EXPORT_STORAGE_MODE,
      demoStorageMode: env.DEMO_STORAGE_MODE,
    },
    'server started',
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    stopCapacityMonitor();
    server.close(() => process.exit(0));
  });
