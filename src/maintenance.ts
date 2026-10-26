import 'dotenv/config';

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { db, pool } from './db/client.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { DemoStorage } from './modules/retention/demo-storage.js';
import {
  runRetentionOnce,
  pruneWebhookPayloadsToByteBudget,
} from './modules/retention/retention.job.js';

export function startMaintenance(port = env.MAINTENANCE_PORT) {
  const storage = new DemoStorage();
  let initialized = false;
  let running: Promise<void> | null = null;
  let stopping = false;
  let lastCleanup = 0;

  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.end(storage.metrics());
    } else if (req.url === '/health') {
      res.writeHead(initialized ? 200 : 503);
      res.end(JSON.stringify({ initialized }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);

  async function execute(): Promise<void> {
    try {
      if (!initialized) {
        await migrate(db, {
          migrationsFolder: path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            'db/migrations',
          ),
        });
      }
      if (storage.mode === 'persist' && Date.now() - lastCleanup >= 60_000) {
        await runRetentionOnce();
        await pruneWebhookPayloadsToByteBudget();
        lastCleanup = Date.now();
      }
      await storage.maintain();
      initialized = storage.available;
    } catch {
      initialized = false;
      logger.warn({ errorType: 'MaintenanceUnavailable' }, 'demo maintenance waiting for database');
    }
  }

  function tick(): Promise<void> {
    if (running || stopping) return running ?? Promise.resolve();
    running = execute().finally(() => {
      running = null;
    });
    return running;
  }

  void tick();
  const timer = setInterval(() => void tick(), 5000);
  return {
    server,
    stop: async (): Promise<void> => {
      stopping = true;
      clearInterval(timer);
      await running;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const worker = startMaintenance();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void worker
        .stop()
        .then(() => pool.end())
        .then(() => process.exit(0));
    });
}
