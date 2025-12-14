import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ipAllowList } from '../src/http/middleware/ip-allowlist.js';

function makeApp(allowedIp?: string, trustProxy = false) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.use(ipAllowList(allowedIp));
  app.get('/test', (req, res) => res.status(200).json({ ok: true, ip: req.ip }));
  return app;
}

describe('ipAllowList', () => {
  it('allows requests when allowlist is not configured', async () => {
    const res = await request(makeApp()).get('/test');
    expect(res.status).toBe(200);
  });

  it('allows a matching single IP', async () => {
    const res = await request(makeApp('127.0.0.1')).get('/test');
    expect(res.status).toBe(200);
  });

  it('allows a matching CIDR', async () => {
    const res = await request(makeApp('127.0.0.0/8')).get('/test');
    expect(res.status).toBe(200);
  });

  it('blocks when the IP is not in the allowlist', async () => {
    const res = await request(makeApp('10.0.0.0/8')).get('/test');
    expect(res.status).toBe(403);
  });

  it('respects X-Forwarded-For when trust proxy is enabled', async () => {
    const res = await request(makeApp('10.0.0.0/8', true))
      .get('/test')
      .set('X-Forwarded-For', '10.2.3.4');
    expect(res.status).toBe(200);
  });
});
