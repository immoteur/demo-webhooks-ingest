import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

const repoRoot = process.cwd();

const sourceSpecPath = path.join(repoRoot, 'openapi.yaml');
const derivedSpecPath = path.join(repoRoot, 'openapi.codegen.yaml');
const templatePath = path.join(repoRoot, 'scripts', 'openapi-zod-client.schemas.hbs');
const generatedSchemasPath = path.join(repoRoot, 'src', 'generated', 'schemas.ts');

const ALLOWED_WEBHOOK_KEYS = new Set(['classified-notification', 'classifieds']);

const WEBHOOK_SLUG_OVERRIDES = new Map([['classifieds', 'classifieds-export']]);

function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHttpMethod(method) {
  return ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(
    method.toLowerCase(),
  );
}

async function main() {
  const sourceYaml = await readFile(sourceSpecPath, 'utf8');
  const sourceSpec = YAML.parse(sourceYaml);

  const derivedSpec = structuredClone(sourceSpec);
  derivedSpec.paths = {};

  const webhooks = sourceSpec.webhooks ?? {};
  const usedSlugs = new Set();
  let fallbackIndex = 0;

  for (const [webhookKey, webhookPathItem] of Object.entries(webhooks)) {
    if (!ALLOWED_WEBHOOK_KEYS.has(webhookKey)) continue;

    let slug = WEBHOOK_SLUG_OVERRIDES.get(webhookKey) ?? slugify(webhookKey);
    if (!slug) slug = `webhook-${++fallbackIndex}`;
    while (usedSlugs.has(slug)) slug = `${slug}-${++fallbackIndex}`;
    usedSlugs.add(slug);

    const pathKey = `/webhooks/${slug}`;
    const copiedPathItem = structuredClone(webhookPathItem);

    for (const [method, operation] of Object.entries(copiedPathItem)) {
      if (!isHttpMethod(method)) continue;
      if (operation && typeof operation === 'object' && !operation.operationId) {
        operation.operationId = `webhook_${slug}_${method.toLowerCase()}`;
      }
    }

    derivedSpec.paths[pathKey] = copiedPathItem;
  }

  delete derivedSpec.webhooks;

  await writeFile(derivedSpecPath, YAML.stringify(derivedSpec), 'utf8');

  await mkdir(path.dirname(generatedSchemasPath), { recursive: true });
  await rm(generatedSchemasPath, { recursive: true, force: true });

  execFileSync(
    'pnpm',
    [
      '-s',
      'exec',
      'openapi-zod-client',
      derivedSpecPath,
      '--output',
      generatedSchemasPath,
      '--template',
      templatePath,
      '--export-schemas',
      '--export-types',
    ],
    {
      stdio: 'inherit',
      cwd: repoRoot,
    },
  );
}

await main();
