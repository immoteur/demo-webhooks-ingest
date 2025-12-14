import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const ENV_PATH = process.env.ENV_PATH ?? '.env';

const KEYS = {
  notification: 'SMEE_SOURCE_URL_CLASSIFIED_NOTIFICATION',
  export: 'SMEE_SOURCE_URL_CLASSIFIEDS_EXPORT',
};

function randomAlphaNum(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function createSmeeUrl(prefix) {
  const id = `${prefix}-${randomAlphaNum(16)}`;
  return `https://smee.io/${id}`;
}

function parseEnvLines(text) {
  const lines = text.split(/\r?\n/);
  const indexByKey = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;

    indexByKey.set(key, i);
  }

  return { lines, indexByKey };
}

function getEnvValueFromLine(line) {
  const idx = line.indexOf('=');
  if (idx < 0) return '';
  return line.slice(idx + 1).trim();
}

async function main() {
  let envText = '';
  try {
    envText = await readFile(ENV_PATH, 'utf8');
  } catch {
    // If missing, create it (Makefile usually copies from .env.example first).
    envText = '';
  }

  const { lines, indexByKey } = parseEnvLines(envText);

  const desired = {};

  for (const [kind, key] of Object.entries(KEYS)) {
    const idx = indexByKey.get(key);
    const existingValue = idx !== undefined && lines[idx] ? getEnvValueFromLine(lines[idx]) : '';
    if (existingValue && existingValue.trim() !== '') {
      desired[key] = existingValue.trim();
      continue;
    }

    desired[key] =
      kind === 'notification'
        ? createSmeeUrl('classified-notification')
        : createSmeeUrl('classifieds-export');
  }

  for (const [key, value] of Object.entries(desired)) {
    const idx = indexByKey.get(key);
    if (idx !== undefined) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  const nextText = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  await writeFile(ENV_PATH, nextText, 'utf8');

  console.log('[smee] Relay endpoints:');
  console.log(`- classified-notification: ${desired[KEYS.notification]}`);
  console.log(`- classifieds-export:      ${desired[KEYS.export]}`);
}

await main();
