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

  it('allows requests when the standalone allowlist is blank', async () => {
    // Given
    const app = makeApp('  ');

    // When
    const res = await request(app).get('/test');

    // Then
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

  it.each(['10.2.3.4', '192.0.2.9'])(
    'allows listed proxy source %s in a whitespace-separated list',
    async (sourceIp) => {
      // Given
      const app = makeApp(' 10.0.0.0/8 , 192.0.2.9 ', true);

      // When
      const res = await request(app).get('/test').set('X-Forwarded-For', sourceIp);

      // Then
      expect(res.status).toBe(200);
    },
  );

  it('allows IPv6 entries and mapped IPv4 request addresses', async () => {
    // Given
    const app = makeApp('2001:db8::/32, 192.0.2.9', true);

    // When
    const ipv6 = await request(app).get('/test').set('X-Forwarded-For', '2001:db8::1');
    const mapped = await request(app).get('/test').set('X-Forwarded-For', '::ffff:192.0.2.9');

    // Then
    expect(ipv6.status).toBe(200);
    expect(mapped.status).toBe(200);
  });

  it('allows an exact IPv6 address with equivalent request spelling', async () => {
    // Given
    const app = makeApp('2001:db8::1', true);

    // When
    const res = await request(app).get('/test').set('X-Forwarded-For', '2001:0db8:0:0:0:0:0:1');

    // Then
    expect(res.status).toBe(200);
  });

  it('treats a mixed-family CIDR as a nonmatch', async () => {
    // Given
    const app = makeApp('2001:db8::/32', true);

    // When
    const res = await request(app).get('/test').set('X-Forwarded-For', '192.0.2.9');

    // Then
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false });
  });

  it('rejects an unlisted source and a forged forwarding chain', async () => {
    // Given
    const app = makeApp('10.0.0.0/8, 192.0.2.9', true);

    // When
    const res = await request(app).get('/test').set('X-Forwarded-For', '10.2.3.4, 203.0.113.10');

    // Then
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ok: false });
  });

  it.each(['10.0.0.1,', ',10.0.0.1', '10.0.0.1,,192.0.2.9', '10.0.0.1,invalid'])(
    'rejects malformed list %s before serving requests',
    (allowedIp) => {
      // Given
      const expectedMessage = 'WEBHOOK_ALLOWED_IP';

      // When
      const createApp = () => makeApp(allowedIp);

      // Then
      expect(createApp).toThrow(expectedMessage);
    },
  );
});
