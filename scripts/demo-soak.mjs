import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { values } = parseArgs({
  options: {
    'duration-seconds': { type: 'string', default: '600' },
    'single-rps': { type: 'string', default: '25' },
    'batch-rps': { type: 'string', default: '5' },
    'export-rps': { type: 'string', default: '2' },
    'assert-reset-cycles': { type: 'string', default: '3' },
    'base-url': { type: 'string', default: 'http://127.0.0.1:8080' },
    'maintenance-url': { type: 'string', default: 'http://127.0.0.1:8081' },
    'stress-database-container': { type: 'string' },
  },
});
const base = new URL(values['base-url']);
const maintenance = new URL(values['maintenance-url']);
for (const url of [base, maintenance])
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Soak runs require a disposable localhost target',
  );
const seconds = Number(values['duration-seconds']);
assert(
  Number.isInteger(seconds) && seconds > 0 && seconds <= 3600,
  'Duration must be 1–3600 seconds',
);
const seed = JSON.parse(
  await readFile(
    new URL('../demo/payloads/classified-notification.example.json', import.meta.url),
    'utf8',
  ),
);
const latencies = [];
let peakDatabaseBytes = 0;
let peakRss = 0;
let errors = 0;
const failures = { response: 0, transport: 0, generatorBacklog: 0 };
const failureExamples = [];
let responses = 0;
const outcomes = { sampled: 0, 'metadata-only': 0, skipped: 0 };
const signals = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => signals.abort());

async function metrics(url) {
  const response = await fetch(new URL('/metrics', url), {
    signal: AbortSignal.any([signals.signal, AbortSignal.timeout(3000)]),
  });
  assert(response.ok, 'Metrics endpoint unavailable');
  return Object.fromEntries(
    (await response.text())
      .trim()
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        const [name, value] = line.split(/\s+/);
        return [name, Number(value)];
      }),
  );
}

const before = await metrics(maintenance);
const start = performance.now();
const deadline = start + seconds * 1000;

const pressure = (async () => {
  const container = values['stress-database-container'];
  if (!container) return;
  assert(/^[a-zA-Z0-9_-]+$/.test(container), 'Invalid disposable container name');
  const docker = promisify(execFile);
  const identity = await docker('docker', [
    'inspect',
    '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}',
    container,
  ]);
  assert.equal(
    identity.stdout.trim(),
    'demo-hardening-soak',
    'Pressure injection requires the exact disposable Compose project',
  );
  const targetCycles = Number(values['assert-reset-cycles']);
  assert(
    Number.isInteger(targetCycles) && targetCycles >= 0 && targetCycles <= 5,
    'Invalid reset target',
  );
  for (let cycle = 0; cycle < targetCycles; cycle++) {
    await delay(
      Math.max(0, start + ((cycle + 1) * seconds * 1000) / (targetCycles + 1) - performance.now()),
    );
    if (signals.signal.aborted) return;
    const baseline = (await metrics(maintenance)).demo_ingest_resets_total;
    // A bounded legacy-data fixture exercises physical reclamation while real HTTP traffic continues.
    for (let batch = 0; batch < 24; batch++) {
      const receipt = await docker('docker', [
        'exec',
        container,
        'psql',
        '-X',
        '-U',
        'postgres',
        '-d',
        'webhooks_ingest',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        "SET statement_timeout='5s'; UPDATE webhook_events SET payload=(SELECT jsonb_build_object('raw',string_agg(md5(g::text||random()::text),'')) FROM generate_series(1,128000) g) WHERE id=(SELECT id FROM webhook_events ORDER BY received_at DESC,id DESC LIMIT 1); SELECT pg_database_size(current_database());",
      ]);
      const bytes = Number(receipt.stdout.trim().split('\n').at(-1));
      assert(Number.isFinite(bytes), 'Missing physical allocation receipt');
      peakDatabaseBytes = Math.max(peakDatabaseBytes, bytes);
      if (
        bytes >= 70 * 1024 ** 2 ||
        (await metrics(maintenance)).demo_ingest_resets_total > baseline
      )
        break;
    }
    const resetDeadline = performance.now() + 20_000;
    let reset = false;
    while (performance.now() < resetDeadline && !signals.signal.aborted) {
      if ((await metrics(maintenance)).demo_ingest_resets_total > baseline) {
        reset = true;
        break;
      }
      await delay(500);
    }
    assert(reset, 'Physical pressure did not trigger bounded reclamation');
  }
})();

function item(large = false) {
  const result = structuredClone(seed);
  result.id = randomUUID();
  const now = new Date().toISOString();
  result.meta.lastSeenAt = now;
  result.meta.lastModifiedAt = now;
  if (large) result.description = randomBytes(42000).toString('base64');
  return result;
}

async function send(route, body, headers = {}) {
  const began = performance.now();
  try {
    const response = await fetch(new URL('/webhooks/' + route, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signals.signal, AbortSignal.timeout(5000)]),
    });
    const result = await response.json();
    if (response.status !== 200 || !result.ok || !(result.storage in outcomes)) {
      errors++;
      failures.response++;
      if (failureExamples.length < 5)
        failureExamples.push({ route, status: response.status, result });
    } else outcomes[result.storage]++;
  } catch (error) {
    errors++;
    failures.transport++;
    if (failureExamples.length < 5) failureExamples.push({ route, error: String(error) });
  } finally {
    responses++;
    latencies.push(performance.now() - began);
  }
}

async function stream(rate, phase, operation) {
  assert(
    Number.isFinite(rate) && rate > 0 && rate <= 100,
    'Each rate must be between zero and 100',
  );
  const pending = new Set();
  let tick = 0;
  while (performance.now() < deadline && !signals.signal.aborted) {
    const due = start + phase + (tick++ * 1000) / rate;
    if (due >= deadline) break;
    await delay(Math.max(0, due - performance.now()));
    if (pending.size >= 32) {
      errors++;
      failures.generatorBacklog++;
      continue;
    }
    const request = operation().finally(() => pending.delete(request));
    pending.add(request);
  }
  await Promise.all(pending);
}

const monitor = (async () => {
  while (performance.now() < deadline && !signals.signal.aborted) {
    const [api, worker] = await Promise.all([metrics(base), metrics(maintenance)]);
    peakDatabaseBytes = Math.max(
      peakDatabaseBytes,
      api.demo_ingest_database_bytes,
      worker.demo_ingest_database_bytes,
    );
    peakRss = Math.max(peakRss, api.demo_ingest_resident_memory_bytes);
    assert(
      api.demo_ingest_sample_listings <= 1000 && api.demo_ingest_sample_receipts <= 1000,
      'Sample row cap exceeded',
    );
    assert(
      worker.demo_ingest_resident_memory_bytes < 256 * 1024 ** 2,
      'Maintenance RSS exceeded limit',
    );
    await delay(2000);
  }
})();

await Promise.all([
  stream(Number(values['batch-rps']), 0, () =>
    send(
      'classified-notification-batch',
      { items: Array.from({ length: 10 }, () => item(true)) },
      {
        'User-Agent': 'Immoteur/disposable-demo-soak',
        'X-Immoteur-Service-Id': '00000000-0000-4000-8000-000000000001',
        'X-Immoteur-Event-Id': randomUUID(),
        'X-Immoteur-Delivery-Id': randomUUID(),
        'X-Immoteur-Timestamp': String(Math.floor(Date.now() / 1000)),
      },
    ),
  ),
  stream(Number(values['single-rps']), 20, () => send('classified-notification', item())),
  stream(Number(values['export-rps']), 100, () =>
    send('classifieds-export', {
      exportId: randomUUID(),
      items: Array.from({ length: 200 }, () => item()),
    }),
  ),
  monitor,
  pressure,
]);
const after = await metrics(maintenance);
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? Infinity;
const resets = after.demo_ingest_resets_total - before.demo_ingest_resets_total;
const summary = {
  seconds,
  responses,
  errors,
  failures,
  failureExamples,
  outcomes,
  p95Milliseconds: p95,
  resets,
  peakDatabaseBytes,
  peakRss,
};
process.stdout.write(JSON.stringify(summary) + '\n');
assert(!signals.signal.aborted, 'Soak interrupted');
assert.equal(errors, 0, 'Valid requests failed');
assert(p95 < 2000, 'p95 latency exceeded two seconds');
assert(peakRss < 1024 ** 3, 'API RSS exceeded limit');
assert(
  peakDatabaseBytes <= 96 * 1024 ** 2,
  'Reduced-budget physical allocation exceeded 32-MiB headroom',
);
assert(resets >= Number(values['assert-reset-cycles']), 'Insufficient physical reset cycles');
