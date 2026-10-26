import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { env } from '../env.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: process.env.DEMO_PROCESS === 'maintenance' ? 1 : 2,
  connectionTimeoutMillis: 1000,
  statement_timeout: 2000,
  idleTimeoutMillis: 5000,
});

pool.on('error', () =>
  logger.warn({ errorType: 'DatabaseUnavailable' }, 'database pool unavailable'),
);

export const db = drizzle(pool, { schema });
