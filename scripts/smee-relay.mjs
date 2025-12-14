import SmeeClient from 'smee-client';

const source = process.env.SMEE_SOURCE_URL;
const target = process.env.SMEE_TARGET_URL ?? 'http://api:3000/webhooks/classified-notification';

if (!source || source.trim() === '') {
  console.error(
    'Missing SMEE_SOURCE_URL (run `node scripts/smee-ensure.mjs` to generate it; keys: SMEE_SOURCE_URL_CLASSIFIED_NOTIFICATION / SMEE_SOURCE_URL_CLASSIFIEDS_EXPORT)',
  );
  process.exit(1);
}

console.log(`Starting smee relay: ${source} -> ${target}`);

const smee = new SmeeClient({
  source,
  target,
  logger: console,
});

const events = smee.start();

function shutdown(signal) {
  console.log(`Stopping smee relay (${signal})`);
  try {
    events.close?.();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
