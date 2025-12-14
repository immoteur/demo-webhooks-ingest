import { writeFile } from 'node:fs/promises';

const DEFAULT_OPENAPI_URL = 'https://api.immoteur.com/assets/openapi-v1.yaml';
const OPENAPI_URL = process.env.OPENAPI_URL ?? DEFAULT_OPENAPI_URL;
const OUTPUT_PATH = new URL('../openapi.yaml', import.meta.url);

console.log(`[openapi-sync] Downloading spec from: ${OPENAPI_URL}`);

const res = await fetch(OPENAPI_URL, {
  headers: {
    accept: 'application/yaml, text/yaml, text/plain, */*',
  },
});

if (!res.ok) {
  throw new Error(`Failed to download OpenAPI spec: ${res.status} ${res.statusText}`);
}

const body = await res.text();
await writeFile(OUTPUT_PATH, body, 'utf8');

console.log(`Saved OpenAPI spec to ${OUTPUT_PATH.pathname}`);
