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

async function getPublicMetabaseDashboardUrl({ metabaseUrl, adminEmail, adminPassword }) {
  const sessionRes = await fetch(`${metabaseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminEmail, password: adminPassword }),
  });

  const sessionJson = await sessionRes.json().catch(() => null);
  const sessionId = sessionJson?.id;
  if (!sessionRes.ok || typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('Metabase login failed (check METABASE_ADMIN_EMAIL / METABASE_ADMIN_PASSWORD)');
  }

  await fetch(`${metabaseUrl}/api/setting/enable-public-sharing`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ value: true }),
  });

  const dashIdRes = await fetch(`${metabaseUrl}/api/setting/custom-homepage-dashboard`, {
    headers: { 'X-Metabase-Session': sessionId },
  });
  const dashIdText = await dashIdRes.text();
  const dashboardId = Number.parseInt(dashIdText, 10);
  if (!dashIdRes.ok || !Number.isFinite(dashboardId)) {
    throw new Error('Unable to resolve dashboard id (custom-homepage-dashboard not set)');
  }

  const dashboardRes = await fetch(`${metabaseUrl}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });
  const dashboardJson = await dashboardRes.json().catch(() => null);
  let publicUuid = dashboardJson?.public_uuid;

  if (typeof publicUuid !== 'string' || publicUuid.trim() === '') {
    const createdRes = await fetch(`${metabaseUrl}/api/dashboard/${dashboardId}/public_link`, {
      method: 'POST',
      headers: { 'X-Metabase-Session': sessionId },
    });
    const createdJson = await createdRes.json().catch(() => null);
    publicUuid = createdJson?.uuid;
  }

  if (typeof publicUuid !== 'string' || publicUuid.trim() === '') {
    throw new Error('Failed to create/read Metabase public dashboard link');
  }

  return `${metabaseUrl}/public/dashboard/${publicUuid}`;
}

await loadDotEnv('.env');

const API_HOST_PORT = process.env.API_HOST_PORT ?? '8080';
const METABASE_HOST_PORT = process.env.METABASE_HOST_PORT ?? '3001';

const API_URL = process.env.DEMO_API_URL ?? `http://localhost:${API_HOST_PORT}`;
const METABASE_URL = process.env.DEMO_METABASE_URL ?? `http://localhost:${METABASE_HOST_PORT}`;

const METABASE_ADMIN_EMAIL = process.env.METABASE_ADMIN_EMAIL ?? 'demo@example.com';
const METABASE_ADMIN_PASSWORD = process.env.METABASE_ADMIN_PASSWORD ?? 'DemoAdmin!2025ChangeMe';

const SMEE_NOTIFICATION = process.env.SMEE_SOURCE_URL_CLASSIFIED_NOTIFICATION ?? '';
const SMEE_EXPORT = process.env.SMEE_SOURCE_URL_CLASSIFIEDS_EXPORT ?? '';

console.log(`[demo] Waiting for API at ${API_URL}...`);
await waitForOk(`${API_URL}/health`, { timeoutMs: 120_000 });

console.log('');
console.log('[demo] Ready (live mode, no seed):');
console.log(`- API:      ${API_URL}`);
console.log(`- Metabase: ${METABASE_URL}`);
console.log(`- Metabase admin: ${METABASE_ADMIN_EMAIL} / ${METABASE_ADMIN_PASSWORD}`);

try {
  const publicDashboardUrl = await getPublicMetabaseDashboardUrl({
    metabaseUrl: METABASE_URL,
    adminEmail: METABASE_ADMIN_EMAIL,
    adminPassword: METABASE_ADMIN_PASSWORD,
  });
  console.log(`- Metabase public dashboard: ${publicDashboardUrl}`);
} catch (err) {
  console.log(`- Metabase public dashboard: (not available: ${String(err)})`);
}

console.log('');
console.log('[demo] smee relays (send webhooks here):');
console.log(`- classified-notification: ${SMEE_NOTIFICATION || '(missing)'}`);
console.log(`- classifieds-export:      ${SMEE_EXPORT || '(missing)'}`);
