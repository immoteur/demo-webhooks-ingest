import pino from 'pino';

import { env } from './env.js';

const defaultLevel = process.env.NODE_ENV === 'test' ? 'silent' : 'info';

export const logger = pino({
  level: env.LOG_LEVEL ?? defaultLevel,
});
