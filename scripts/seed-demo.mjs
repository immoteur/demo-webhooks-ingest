import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

async function loadDotEnv(path) {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf('=');
    if (idx <= 0) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

await loadDotEnv('.env');

const API_HOST_PORT = process.env.API_HOST_PORT ?? '8080';
const METABASE_HOST_PORT = process.env.METABASE_HOST_PORT ?? '3001';

const API_URL = process.env.DEMO_API_URL ?? `http://localhost:${API_HOST_PORT}`;
const METABASE_URL = process.env.DEMO_METABASE_URL ?? `http://localhost:${METABASE_HOST_PORT}`;

const METABASE_ADMIN_EMAIL = process.env.METABASE_ADMIN_EMAIL ?? 'demo@example.com';
const METABASE_ADMIN_PASSWORD = process.env.METABASE_ADMIN_PASSWORD ?? 'DemoAdmin!2025ChangeMe';

const CLASSIFIED_COUNT = Number.parseInt(process.env.DEMO_CLASSIFIED_COUNT ?? '25', 10);
const EXPORT_ITEM_COUNT = Number.parseInt(process.env.DEMO_EXPORT_ITEM_COUNT ?? '10', 10);
const PROPERTY_POOL_SIZE = Math.max(
  1,
  Number.parseInt(process.env.DEMO_PROPERTY_POOL_SIZE ?? '8', 10),
);
const PROPERTY_IDS = Array.from({ length: PROPERTY_POOL_SIZE }, () => randomUUID());

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOk(url, { timeoutMs }) {
  const startedAt = Date.now();
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timeout waiting for ${url}`);
    }
    await sleep(500);
  }
}

function toIsoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function postJson(path, body) {
  const headers = { 'content-type': 'application/json' };

  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    throw new Error(
      `POST ${path} failed: ${res.status} ${res.statusText}\n${
        typeof text === 'string' ? text : JSON.stringify(json)
      }`,
    );
  }

  return json ?? text;
}

function mutateClassifiedNotification(base, { index, now }) {
  const c = structuredClone(base);

  c.id = randomUUID();
  c.propertyId = PROPERTY_IDS[index % PROPERTY_IDS.length];

  const lastModifiedAt = new Date(now.getTime() - (CLASSIFIED_COUNT - index) * 60_000);
  const firstSeenAt = new Date(lastModifiedAt.getTime() - 30 * 60_000);

  c.meta.firstSeenAt = toIsoSeconds(firstSeenAt);
  c.meta.lastModifiedAt = toIsoSeconds(lastModifiedAt);
  c.meta.lastSeenAt = toIsoSeconds(lastModifiedAt);

  if (c.transaction?.price) {
    const basePrice =
      typeof c.transaction.price.current === 'number' ? c.transaction.price.current : 650000;
    const current = basePrice + index * 10_000;
    c.transaction.price.current = current;
    c.transaction.price.initial = current;
    if (Array.isArray(c.transaction.price.history) && c.transaction.price.history[0]) {
      c.transaction.price.history[0].id = randomUUID();
      c.transaction.price.history[0].value = current;
      c.transaction.price.history[0].timestamp = toIsoSeconds(lastModifiedAt);
    }
  }

  if (c.source?.url && typeof c.source.url === 'string') {
    c.source.url = `${c.source.url}?demo=${index + 1}`;
  }

  return c;
}

function mutateClassifiedExportItem(baseItem, { index, now }) {
  const c = structuredClone(baseItem);

  c.id = randomUUID();
  c.propertyId = PROPERTY_IDS[index % PROPERTY_IDS.length];

  const lastModifiedAt = new Date(now.getTime() - (EXPORT_ITEM_COUNT - index) * 60_000);
  const firstSeenAt = new Date(lastModifiedAt.getTime() - 30 * 60_000);

  c.meta.firstSeenAt = toIsoSeconds(firstSeenAt);
  c.meta.lastModifiedAt = toIsoSeconds(lastModifiedAt);
  c.meta.lastSeenAt = toIsoSeconds(lastModifiedAt);

  if (c.transaction?.price) {
    const basePrice =
      typeof c.transaction.price.current === 'number' ? c.transaction.price.current : 650000;
    const current = basePrice + index * 10_000;
    c.transaction.price.current = current;
    c.transaction.price.initial = current;
    if (Array.isArray(c.transaction.price.history) && c.transaction.price.history[0]) {
      c.transaction.price.history[0].id = randomUUID();
      c.transaction.price.history[0].value = current;
      c.transaction.price.history[0].timestamp = toIsoSeconds(lastModifiedAt);
    }
  }

  if (c.source?.url && typeof c.source.url === 'string') {
    c.source.url = `${c.source.url}?demo_export=${index + 1}`;
  }

  return c;
}

async function getPublicMetabaseDashboardUrl() {
  const sessionRes = await fetch(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: METABASE_ADMIN_EMAIL, password: METABASE_ADMIN_PASSWORD }),
  });

  const sessionJson = await sessionRes.json().catch(() => null);
  const sessionId = sessionJson?.id;
  if (!sessionRes.ok || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('Metabase login failed (check METABASE_ADMIN_EMAIL / METABASE_ADMIN_PASSWORD)');
  }

  await fetch(`${METABASE_URL}/api/setting/enable-public-sharing`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ value: true }),
  });

  const dashIdRes = await fetch(`${METABASE_URL}/api/setting/custom-homepage-dashboard`, {
    headers: { 'X-Metabase-Session': sessionId },
  });
  const dashIdText = await dashIdRes.text();
  const dashboardId = Number.parseInt(dashIdText, 10);
  if (!dashIdRes.ok || !Number.isFinite(dashboardId)) {
    throw new Error('Unable to resolve dashboard id (custom-homepage-dashboard not set)');
  }

  const dashboardRes = await fetch(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });
  const dashboardJson = await dashboardRes.json().catch(() => null);
  let publicUuid = dashboardJson?.public_uuid;

  if (typeof publicUuid !== 'string' || publicUuid.trim() === '') {
    const createdRes = await fetch(`${METABASE_URL}/api/dashboard/${dashboardId}/public_link`, {
      method: 'POST',
      headers: { 'X-Metabase-Session': sessionId },
    });
    const createdJson = await createdRes.json().catch(() => null);
    publicUuid = createdJson?.uuid;
  }

  if (typeof publicUuid !== 'string' || publicUuid.trim() === '') {
    throw new Error('Failed to create/read Metabase public dashboard link');
  }

  return `${METABASE_URL}/public/dashboard/${publicUuid}`;
}

async function main() {
  console.log(`[demo] Waiting for API at ${API_URL}...`);
  await waitForOk(`${API_URL}/health`, { timeoutMs: 120_000 });

  const notificationBase = JSON.parse(
    await readFile('demo/payloads/classified-notification.example.json', 'utf8'),
  );
  const exportBase = JSON.parse(
    await readFile('demo/payloads/classifieds-export.example.json', 'utf8'),
  );

  const now = new Date();

  console.log(`[demo] Seeding ${CLASSIFIED_COUNT} classified notifications...`);
  for (let i = 0; i < CLASSIFIED_COUNT; i += 1) {
    const payload = mutateClassifiedNotification(notificationBase, { index: i, now });
    await postJson('/webhooks/classified-notification', payload);
  }

  if (Array.isArray(exportBase.items) && exportBase.items[0]) {
    console.log(`[demo] Seeding 1 classifieds export (${EXPORT_ITEM_COUNT} items)...`);
    const baseItem = exportBase.items[0];
    const items = [];
    for (let i = 0; i < EXPORT_ITEM_COUNT; i += 1) {
      items.push(mutateClassifiedExportItem(baseItem, { index: i, now }));
    }

    await postJson('/webhooks/classifieds-export', {
      exportId: randomUUID(),
      items,
    });
  }

  console.log('');
  console.log('[demo] Ready:');
  console.log(`- API:      ${API_URL}`);
  console.log(`- Metabase: ${METABASE_URL}`);
  console.log(`- Metabase admin: ${METABASE_ADMIN_EMAIL} / ${METABASE_ADMIN_PASSWORD}`);
  try {
    const publicDashboardUrl = await getPublicMetabaseDashboardUrl();
    console.log(`- Metabase public dashboard: ${publicDashboardUrl}`);
  } catch (err) {
    console.log(`- Metabase public dashboard: (not available: ${String(err)})`);
  }
}

await main();
