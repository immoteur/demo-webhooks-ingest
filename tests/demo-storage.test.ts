import { readFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { once } from 'node:events';

import request from 'supertest';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import type * as Server from '../src/server.js';

describe('sample acknowledgement', () => {
  let createApp: typeof Server.createApp;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable';
    process.env.LOG_LEVEL = 'silent';
    ({ createApp } = await import('../src/server.js'));
  });

  it('acknowledges a valid notification when the database is unavailable', async () => {
    // Given
    const payload: unknown = JSON.parse(
      await readFile('demo/payloads/classified-notification.example.json', 'utf8'),
    );
    const app = createApp();

    // When
    const response = await request(app).post('/webhooks/classified-notification').send(payload);

    // Then
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, storage: 'skipped' });
  });

  it('preserves valid request IDs independently of storage', async () => {
    // Given
    const id = '00000000-0000-4000-8000-000000000001';
    const app = createApp();

    // When
    const response = await request(app).get('/health').set('X-Request-ID', id);

    // Then
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe(id);
  });

  it('preserves allowlist precedence at the concurrency limit and releases closed requests', async () => {
    // Given
    const app = createApp({ webhookAllowedIp: '10.2.3.4' });
    app.set('trust proxy', 1);
    const server = createServer(app);
    const clients: ClientRequest[] = [];
    onTestFinished(async () => {
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
    const received: IncomingMessage[] = [];
    for (let index = 0; index < 8; index++) {
      const arrived = once(server, 'request');
      const client = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/webhooks/classified-notification',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '1000',
          'X-Forwarded-For': '10.2.3.4',
        },
      });
      client.on('error', (error) => {
        if (!client.destroyed) throw error;
      });
      clients.push(client);
      client.write('{');
      received.push((await arrived)[0]);
    }

    // When
    const denied = await request(server)
      .post('/webhooks/classified-notification')
      .set('X-Forwarded-For', '192.0.2.9')
      .send({});
    const overloaded = await request(server)
      .post('/webhooks/classified-notification')
      .set('X-Forwarded-For', '10.2.3.4')
      .send({});

    // Then
    expect(denied.status).toBe(403);
    expect(overloaded.status).toBe(429);
    expect(overloaded.headers['retry-after']).toBe('1');
    expect((await request(server).get('/health')).status).toBe(200);
    const closed = new Promise<void>((resolve) => received[0].once('close', resolve));
    clients[0].destroy();
    await closed;
    const payload: unknown = JSON.parse(
      await readFile('demo/payloads/classified-notification.example.json', 'utf8'),
    );
    const resumed = await request(server)
      .post('/webhooks/classified-notification')
      .set('X-Forwarded-For', '10.2.3.4')
      .send(payload);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ ok: true, storage: 'skipped' });
  });

  it('replaces malformed optional request IDs', async () => {
    // Given
    const app = createApp();

    // When
    const response = await request(app).get('/health').set('X-Request-ID', 'invalid');

    // Then
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    'classified-notification-single',
    'classified-notification-batch',
    'classifieds-export',
    'classified-export',
  ])('acknowledges the default sample route %s without a database', async (route) => {
    // Given
    const item: unknown = JSON.parse(
      await readFile('demo/payloads/classified-notification.example.json', 'utf8'),
    );
    const payload =
      route === 'classified-notification-single'
        ? item
        : route === 'classified-notification-batch'
          ? { items: [item] }
          : { exportId: '00000000-0000-4000-8000-000000000004', items: [item] };
    const headers = {
      'User-Agent': 'Immoteur/test',
      'X-Immoteur-Service-Id': '00000000-0000-4000-8000-000000000001',
      'X-Immoteur-Event-Id': '00000000-0000-4000-8000-000000000002',
      'X-Immoteur-Delivery-Id': '00000000-0000-4000-8000-000000000003',
      'X-Immoteur-Timestamp': '1757926800',
    };

    // When
    const response = await request(createApp())
      .post('/webhooks/' + route)
      .set(headers)
      .send(payload);

    // Then
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, storage: 'skipped', storedItems: 0 });
  });
});
