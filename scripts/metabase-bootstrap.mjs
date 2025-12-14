import { randomUUID } from 'node:crypto';

const METABASE_URL = process.env.METABASE_URL ?? 'http://metabase:3000';
const METABASE_DB_HOST = process.env.METABASE_DB_HOST ?? 'postgres';
const METABASE_DB_PORT = Number(process.env.METABASE_DB_PORT ?? 5432);

const SITE_NAME = process.env.METABASE_SITE_NAME ?? 'Webhook Ingest Demo';
const ADMIN_EMAIL = process.env.METABASE_ADMIN_EMAIL ?? 'demo@example.com';
const ADMIN_PASSWORD = process.env.METABASE_ADMIN_PASSWORD ?? 'DemoAdmin!2025ChangeMe';

const POSTGRES_DB = process.env.POSTGRES_DB ?? 'webhooks_ingest';
const METABASE_READER_USER = process.env.METABASE_READER_USER ?? 'metabase_reader';
const METABASE_READER_PASSWORD = process.env.METABASE_READER_PASSWORD ?? 'CHANGE_ME';

const PROPERTY_TYPE_VALUES = [
  'apartment',
  'building',
  'house',
  'land',
  'office',
  'other',
  'parking',
  'premises',
  'program',
  'shop',
];

const TRANSACTION_TYPE_VALUES = ['rent', 'sale'];

const METABASE_DB_NAME = 'Webhook DB';

const COLLECTION_NAME = 'Demo';
const COLLECTION_DESCRIPTION = 'Webhook ingestion demo dashboards';

const DASHBOARD_NAME = 'Webhook Demo';
const DASHBOARD_DESCRIPTION = 'Live webhook ingestion demo';

const TAB_NAMES = {
  CLASSIFIEDS: 'Classifieds',
  PROPERTIES: 'Properties',
  WEBHOOKS: 'Webhooks',
};

const TEMPLATE_TAGS = {
  PROPERTY_TYPE: 'property_type',
  TRANSACTION_TYPE: 'transaction_type',
};

const DASHBOARD_FILTERS = {
  PROPERTY_TYPE: {
    name: 'Property type',
    slug: TEMPLATE_TAGS.PROPERTY_TYPE,
  },
  TRANSACTION_TYPE: {
    name: 'Transaction type',
    slug: TEMPLATE_TAGS.TRANSACTION_TYPE,
  },
};

const CARD_NAMES = {
  CLASSIFIEDS_BY_TYPE: 'Classifieds by property and transaction type',
  CLASSIFIEDS_BY_DEPARTMENT: 'Classifieds by department',
  CLASSIFIEDS_BY_STATUS: 'Classifieds by status',
  AVG_PRICE_BY_DEPARTMENT: 'Avg price by department',
  LATEST_CLASSIFIEDS: 'Latest classifieds',
  DUPLICATED_PROPERTIES_BY_SOURCE_DOMAIN: 'Duplicated properties by source domain',
  LISTINGS_PER_PROPERTY: 'Listings per property',
  LATEST_PROPERTIES: 'Latest properties',
  WEBHOOK_EVENTS_PER_MINUTE: 'Webhook events (per minute)',
  PARSE_VALIDITY: 'Parse validity',
  WEBHOOK_EVENTS_BY_TYPE: 'Webhook events by type',
  LATEST_WEBHOOK_EVENTS: 'Latest webhook events',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, json, text };
}

async function requestJson(url, options) {
  const res = await request(url, options);
  if (res.ok) return res.json;

  const message = `HTTP ${res.status} ${res.statusText} for ${url}`;
  const detail = res.json ?? res.text;
  throw new Error(`${message}\n${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function waitForMetabase(timeoutMs) {
  const startedAt = Date.now();
  while (true) {
    try {
      const res = await request(`${METABASE_URL}/api/session/properties`);
      if (res.ok) return;
    } catch {
      // ignore
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timeout waiting for Metabase at ${METABASE_URL}`);
    }
    await sleep(1000);
  }
}

async function tryLogin() {
  const res = await request(`${METABASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });

  if (!res.ok) return null;
  const sessionId = res.json?.id;
  return typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId : null;
}

async function setupMetabase() {
  const props = await requestJson(`${METABASE_URL}/api/session/properties`);
  const setupToken = props?.['setup-token'];
  if (typeof setupToken !== 'string' || setupToken.trim() === '') {
    throw new Error('Metabase setup token not available');
  }

  console.log('[metabase-bootstrap] Running first-time setup...');

  await requestJson(`${METABASE_URL}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: setupToken,
      user: {
        email: ADMIN_EMAIL,
        first_name: 'Demo',
        last_name: 'Admin',
        password: ADMIN_PASSWORD,
      },
      prefs: {
        site_name: SITE_NAME,
        allow_tracking: false,
        site_locale: 'en',
      },
    }),
  });

  console.log('[metabase-bootstrap] Setup complete.');
}

async function ensureDatabase(sessionId) {
  const dbs = await requestJson(`${METABASE_URL}/api/database`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existing = dbs?.data?.find((db) => db?.name === METABASE_DB_NAME);
  if (existing?.id) return existing.id;

  console.log(`[metabase-bootstrap] Creating Postgres connection (${METABASE_DB_NAME})...`);
  const created = await requestJson(`${METABASE_URL}/api/database`, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({
      engine: 'postgres',
      name: METABASE_DB_NAME,
      details: {
        host: METABASE_DB_HOST,
        port: METABASE_DB_PORT,
        dbname: POSTGRES_DB,
        user: METABASE_READER_USER,
        password: METABASE_READER_PASSWORD,
        ssl: false,
      },
      is_full_sync: true,
      is_on_demand: false,
      auto_run_queries: true,
    }),
  });

  if (!created?.id) throw new Error('Failed to create database connection (missing id)');
  return created.id;
}

async function ensureCollection(sessionId) {
  const collections = await requestJson(`${METABASE_URL}/api/collection`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existing = collections?.find?.((c) => c?.name === COLLECTION_NAME);
  if (existing?.id && typeof existing.id === 'number') return existing.id;

  const created = await requestJson(`${METABASE_URL}/api/collection`, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: COLLECTION_NAME,
      description: COLLECTION_DESCRIPTION,
    }),
  });

  if (!created?.id) throw new Error('Failed to create collection (missing id)');
  return created.id;
}

async function getCollectionItems(sessionId, collectionId) {
  return requestJson(`${METABASE_URL}/api/collection/${collectionId}/items`, {
    headers: { 'X-Metabase-Session': sessionId },
  });
}

async function resetCollection(sessionId, collectionId) {
  const items = await getCollectionItems(sessionId, collectionId);
  const data = Array.isArray(items?.data) ? items.data : [];

  const dashboardIds = data
    .filter((item) => item?.model === 'dashboard' && typeof item?.id === 'number')
    .map((item) => item.id);
  const cardIds = data
    .filter((item) => item?.model === 'card' && typeof item?.id === 'number')
    .map((item) => item.id);

  for (const dashboardId of dashboardIds) {
    await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
      method: 'DELETE',
      headers: { 'X-Metabase-Session': sessionId },
    });
  }

  for (const cardId of cardIds) {
    await requestJson(`${METABASE_URL}/api/card/${cardId}`, {
      method: 'DELETE',
      headers: { 'X-Metabase-Session': sessionId },
    });
  }
}

async function ensureCard(
  sessionId,
  {
    collectionId,
    databaseId,
    name,
    description,
    display,
    sql,
    templateTags,
    visualizationSettings,
  },
) {
  const nextTemplateTags = templateTags ?? {};
  const nextVisualizationSettings = visualizationSettings ?? {};

  const items = await getCollectionItems(sessionId, collectionId);
  const existing = items?.data?.find((item) => item?.model === 'card' && item?.name === name);
  if (existing?.id) {
    await requestJson(`${METABASE_URL}/api/card/${existing.id}`, {
      method: 'PUT',
      headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        description,
        collection_id: collectionId,
        display,
        dataset_query: {
          database: databaseId,
          type: 'native',
          native: { query: sql, 'template-tags': nextTemplateTags },
        },
        visualization_settings: nextVisualizationSettings,
      }),
    });

    return existing.id;
  }

  console.log(`[metabase-bootstrap] Creating card: ${name}`);
  const created = await requestJson(`${METABASE_URL}/api/card`, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      description,
      collection_id: collectionId,
      display,
      dataset_query: {
        database: databaseId,
        type: 'native',
        native: { query: sql, 'template-tags': nextTemplateTags },
      },
      visualization_settings: nextVisualizationSettings,
    }),
  });

  if (!created?.id) throw new Error(`Failed to create card "${name}" (missing id)`);
  return created.id;
}

async function ensureDashboard(sessionId, { collectionId, name, description }) {
  const items = await getCollectionItems(sessionId, collectionId);
  const existing = items?.data?.find((item) => item?.model === 'dashboard' && item?.name === name);
  if (existing?.id) return existing.id;

  console.log(`[metabase-bootstrap] Creating dashboard: ${name}`);
  const created = await requestJson(`${METABASE_URL}/api/dashboard`, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ name, description, collection_id: collectionId }),
  });

  if (!created?.id) throw new Error(`Failed to create dashboard "${name}" (missing id)`);
  return created.id;
}

async function setDashboardTabsAndCards(
  sessionId,
  dashboardId,
  { tabs, cards, parameterMappingsByCardId },
) {
  const dashboard = await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existingDashcards = Array.isArray(dashboard?.dashcards) ? dashboard.dashcards : [];
  const dashcardIdByCardId = new Map(
    existingDashcards
      .filter((dc) => typeof dc?.card_id === 'number' && typeof dc?.id === 'number')
      .map((dc) => [dc.card_id, dc.id]),
  );

  const existingTabs = Array.isArray(dashboard?.tabs) ? dashboard.tabs : [];
  const tabIdByName = new Map(
    existingTabs
      .filter((t) => typeof t?.id === 'number' && typeof t?.name === 'string')
      .map((t) => [t.name, t.id]),
  );

  const nextParameterMappingsByCardId = parameterMappingsByCardId ?? new Map();

  let nextTempTabId = -1;
  const payloadTabs = tabs.map((name) => ({ id: tabIdByName.get(name) ?? nextTempTabId--, name }));
  const tabIdByNamePayload = new Map(payloadTabs.map((t) => [t.name, t.id]));

  let nextTempDashcardId = -1;
  const payloadCards = cards.map((c) => ({
    id: dashcardIdByCardId.get(c.cardId) ?? nextTempDashcardId--,
    card_id: c.cardId,
    dashboard_tab_id: tabIdByNamePayload.get(c.tab) ?? null,
    row: c.row,
    col: c.col,
    size_x: c.sizeX,
    size_y: c.sizeY,
    ...(Array.isArray(nextParameterMappingsByCardId.get(c.cardId)) &&
    nextParameterMappingsByCardId.get(c.cardId).length > 0
      ? { parameter_mappings: nextParameterMappingsByCardId.get(c.cardId) }
      : {}),
  }));

  await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}/cards`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ cards: payloadCards, tabs: payloadTabs }),
  });
}

async function ensurePropertyTypeDashboardFilter(
  sessionId,
  dashboardId,
  { collectionId, desiredId },
) {
  const dashboard = await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existingParams = Array.isArray(dashboard?.parameters) ? dashboard.parameters : [];
  const existing = existingParams.find((p) => p?.slug === DASHBOARD_FILTERS.PROPERTY_TYPE.slug);
  const id =
    typeof existing?.id === 'string' && existing.id.trim() !== ''
      ? existing.id
      : (desiredId ?? randomUUID());

  const paramBase = {
    id,
    name: DASHBOARD_FILTERS.PROPERTY_TYPE.name,
    slug: DASHBOARD_FILTERS.PROPERTY_TYPE.slug,
    sectionId: 'string',
    default: null,
    isMultiSelect: false,
    values_query_type: 'list',
    values_source_type: 'static-list',
    values_source_config: { values: PROPERTY_TYPE_VALUES },
  };

  const typeCandidates = [
    { type: 'category' },
    { type: 'string/=', 'widget-type': 'category' },
    { type: 'string/=' },
  ];

  let lastError = null;
  for (const candidate of typeCandidates) {
    const nextParam = { ...paramBase, ...candidate };
    const nextParams = [
      ...existingParams.filter((p) => p?.slug !== DASHBOARD_FILTERS.PROPERTY_TYPE.slug),
      nextParam,
    ];

    const payload = {
      name: dashboard?.name ?? DASHBOARD_NAME,
      description: dashboard?.description ?? '',
      parameters: nextParams,
    };
    const nextCollectionId =
      typeof dashboard?.collection_id === 'number' ? dashboard.collection_id : collectionId;
    if (typeof nextCollectionId === 'number') payload.collection_id = nextCollectionId;

    try {
      await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
        method: 'PUT',
        headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;

  return id;
}

async function ensureTransactionTypeDashboardFilter(
  sessionId,
  dashboardId,
  { collectionId, desiredId },
) {
  const dashboard = await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existingParams = Array.isArray(dashboard?.parameters) ? dashboard.parameters : [];
  const existing = existingParams.find((p) => p?.slug === DASHBOARD_FILTERS.TRANSACTION_TYPE.slug);
  const id =
    typeof existing?.id === 'string' && existing.id.trim() !== ''
      ? existing.id
      : (desiredId ?? randomUUID());

  const paramBase = {
    id,
    name: DASHBOARD_FILTERS.TRANSACTION_TYPE.name,
    slug: DASHBOARD_FILTERS.TRANSACTION_TYPE.slug,
    sectionId: 'string',
    default: 'sale',
    required: true,
    isMultiSelect: false,
    values_query_type: 'list',
    values_source_type: 'static-list',
    values_source_config: { values: TRANSACTION_TYPE_VALUES },
  };

  const typeCandidates = [
    { type: 'category' },
    { type: 'string/=', 'widget-type': 'category' },
    { type: 'string/=' },
  ];

  let lastError = null;
  for (const candidate of typeCandidates) {
    const nextParam = { ...paramBase, ...candidate };
    const nextParams = [
      ...existingParams.filter((p) => p?.slug !== DASHBOARD_FILTERS.TRANSACTION_TYPE.slug),
      nextParam,
    ];

    const payload = {
      name: dashboard?.name ?? DASHBOARD_NAME,
      description: dashboard?.description ?? '',
      parameters: nextParams,
    };
    const nextCollectionId =
      typeof dashboard?.collection_id === 'number' ? dashboard.collection_id : collectionId;
    if (typeof nextCollectionId === 'number') payload.collection_id = nextCollectionId;

    try {
      await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
        method: 'PUT',
        headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;

  return id;
}

async function setCustomHomepage(sessionId, dashboardId) {
  await requestJson(`${METABASE_URL}/api/setting/custom-homepage`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ value: true }),
  });

  await requestJson(`${METABASE_URL}/api/setting/custom-homepage-dashboard`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ value: dashboardId }),
  });
}

async function enablePublicSharing(sessionId) {
  await requestJson(`${METABASE_URL}/api/setting/enable-public-sharing`, {
    method: 'PUT',
    headers: { 'X-Metabase-Session': sessionId, 'content-type': 'application/json' },
    body: JSON.stringify({ value: true }),
  });
}

async function ensurePublicDashboardLink(sessionId, dashboardId) {
  const dashboard = await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}`, {
    headers: { 'X-Metabase-Session': sessionId },
  });

  const existing = dashboard?.public_uuid;
  if (typeof existing === 'string' && existing.trim() !== '') return existing;

  const created = await requestJson(`${METABASE_URL}/api/dashboard/${dashboardId}/public_link`, {
    method: 'POST',
    headers: { 'X-Metabase-Session': sessionId },
  });

  const uuid = created?.uuid;
  if (typeof uuid !== 'string' || uuid.trim() === '') {
    throw new Error('Failed to create public dashboard link (missing uuid)');
  }
  return uuid;
}

async function main() {
  console.log(`[metabase-bootstrap] Waiting for Metabase at ${METABASE_URL}...`);
  await waitForMetabase(120_000);

  let sessionId = await tryLogin();
  if (!sessionId) {
    await setupMetabase();
    sessionId = await tryLogin();
  }

  if (!sessionId) {
    throw new Error(
      'Metabase is configured but login failed (check METABASE_ADMIN_EMAIL / METABASE_ADMIN_PASSWORD)',
    );
  }

  const databaseId = await ensureDatabase(sessionId);
  const collectionId = await ensureCollection(sessionId);
  await resetCollection(sessionId, collectionId);

  const propertyTypeTemplateTag = {
    id: randomUUID(),
    name: TEMPLATE_TAGS.PROPERTY_TYPE,
    'display-name': DASHBOARD_FILTERS.PROPERTY_TYPE.name,
    type: 'text',
    'widget-type': 'category',
    required: false,
  };

  const transactionTypeTemplateTag = {
    id: randomUUID(),
    name: TEMPLATE_TAGS.TRANSACTION_TYPE,
    'display-name': DASHBOARD_FILTERS.TRANSACTION_TYPE.name,
    type: 'text',
    'widget-type': 'category',
    required: true,
    default: 'sale',
  };

  const cards = [
    // Classifieds tab
    {
      tab: TAB_NAMES.CLASSIFIEDS,
      row: 0,
      col: 0,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.CLASSIFIEDS_BY_TYPE,
      description: 'Count of classifieds grouped by property_type, stacked by transaction_type',
      display: 'bar',
      sql: `select property_type,
       transaction_type,
       count(*) as classifieds
from classifieds
where true
[[and property_type in ({{${TEMPLATE_TAGS.PROPERTY_TYPE}}})]]
group by 1, 2
order by 1, 2`,
      templateTags: {
        [TEMPLATE_TAGS.PROPERTY_TYPE]: propertyTypeTemplateTag,
      },
      visualizationSettings: {
        'stackable.stack_type': 'stacked',
      },
    },
    {
      tab: TAB_NAMES.CLASSIFIEDS,
      row: 0,
      col: 12,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.CLASSIFIEDS_BY_DEPARTMENT,
      description: 'Count of classifieds grouped by location_department',
      display: 'bar',
      sql: `select location_department as department, count(*) as classifieds
	from classifieds
	where transaction_type in ({{${TEMPLATE_TAGS.TRANSACTION_TYPE}}})
	[[and property_type in ({{${TEMPLATE_TAGS.PROPERTY_TYPE}}})]]
	group by 1
	order by classifieds desc
	limit 20`,
      templateTags: {
        [TEMPLATE_TAGS.TRANSACTION_TYPE]: transactionTypeTemplateTag,
        [TEMPLATE_TAGS.PROPERTY_TYPE]: propertyTypeTemplateTag,
      },
    },
    {
      tab: TAB_NAMES.CLASSIFIEDS,
      row: 6,
      col: 0,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.CLASSIFIEDS_BY_STATUS,
      description: 'Count of classifieds grouped by status_current',
      display: 'bar',
      sql: 'select status_current as status, count(*) as classifieds\nfrom classifieds\ngroup by 1\norder by classifieds desc',
    },
    {
      tab: TAB_NAMES.CLASSIFIEDS,
      row: 6,
      col: 12,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.AVG_PRICE_BY_DEPARTMENT,
      description: 'Average transaction_price_current grouped by location_department',
      display: 'bar',
      sql: `select location_department as department, avg(transaction_price_current) as avg_price
	from classifieds
	where transaction_type in ({{${TEMPLATE_TAGS.TRANSACTION_TYPE}}})
	  and transaction_price_current is not null
	[[and property_type in ({{${TEMPLATE_TAGS.PROPERTY_TYPE}}})]]
	group by 1
	order by avg_price desc
limit 20`,
      templateTags: {
        [TEMPLATE_TAGS.TRANSACTION_TYPE]: transactionTypeTemplateTag,
        [TEMPLATE_TAGS.PROPERTY_TYPE]: propertyTypeTemplateTag,
      },
    },
    {
      tab: TAB_NAMES.CLASSIFIEDS,
      row: 12,
      col: 0,
      sizeX: 24,
      sizeY: 8,
      name: CARD_NAMES.LATEST_CLASSIFIEDS,
      description: 'Most recent classifieds rows',
      display: 'table',
      sql: `select property_type,
       transaction_type,
       transaction_price_current as price,
       location_department as department,
       location_postcode as postcode,
       location_city_name as city_name,
       source_domain
from classifieds
 order by last_received_at desc
 limit 50`,
    },

    // Properties tab
    {
      tab: TAB_NAMES.PROPERTIES,
      row: 0,
      col: 0,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.DUPLICATED_PROPERTIES_BY_SOURCE_DOMAIN,
      description: 'Total properties + top 5 domains (duplicated properties)',
      display: 'bar',
      sql: `with filtered as (
  select property_id, coalesce(source_domain, '(unknown)') as source_domain
  from classifieds
  where transaction_type in ({{${TEMPLATE_TAGS.TRANSACTION_TYPE}}})
  [[and property_type in ({{${TEMPLATE_TAGS.PROPERTY_TYPE}}})]]
),
total as (
  select '(total)'::text as source_domain, count(distinct property_id)::bigint as properties
  from filtered
),
duplicates as (
  select property_id
  from filtered
  group by property_id
  having count(distinct source_domain) > 1
),
by_domain as (
  select f.source_domain, count(distinct f.property_id)::bigint as properties
  from filtered f
  join duplicates d on d.property_id = f.property_id
  group by 1
),
top_domains as (
  select source_domain, properties
  from by_domain
  order by properties desc
  limit 5
)
select source_domain, properties
from (
  select source_domain, properties, 0 as sort_key
  from total
  union all
  select source_domain, properties, 1 as sort_key
  from top_domains
) unioned
order by sort_key, properties desc`,
      templateTags: {
        [TEMPLATE_TAGS.TRANSACTION_TYPE]: transactionTypeTemplateTag,
        [TEMPLATE_TAGS.PROPERTY_TYPE]: propertyTypeTemplateTag,
      },
      visualizationSettings: {
        'graph.dimensions': ['source_domain'],
        'graph.metrics': ['properties'],
      },
    },
    {
      tab: TAB_NAMES.PROPERTIES,
      row: 0,
      col: 12,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.LISTINGS_PER_PROPERTY,
      description: 'Distribution of listing counts per property_id',
      display: 'bar',
      sql: 'with per_property as (\n  select property_id, count(*) as listings\n  from classifieds\n  group by property_id\n)\nselect listings::text as listings_per_property, count(*) as properties\nfrom per_property\ngroup by listings\norder by listings',
    },
    {
      tab: TAB_NAMES.PROPERTIES,
      row: 6,
      col: 0,
      sizeX: 24,
      sizeY: 8,
      name: CARD_NAMES.LATEST_PROPERTIES,
      description: 'Property-level rollup (grouped by property_id)',
      display: 'table',
      sql: `with per_property as (
  select
    property_id,
    max(last_received_at) as last_received_at,
    count(*) as classifieds,
    min(transaction_price_current) as price,
    (array_agg(property_type order by last_received_at desc))[1] as property_type,
    (array_agg(transaction_type order by last_received_at desc))[1] as transaction_type,
    (array_agg(location_department order by (location_department is null), last_received_at desc))[1] as department,
    (array_agg(location_postcode order by (location_postcode is null), last_received_at desc))[1] as postcode,
    (array_agg(location_city_name order by (location_city_name is null), last_received_at desc))[1] as city_name
  from classifieds
  group by property_id
)
select
  property_type,
  transaction_type,
  classifieds,
  price,
  department,
  postcode,
  city_name
from per_property
order by last_received_at desc
limit 50`,
    },

    // Webhooks tab
    {
      tab: TAB_NAMES.WEBHOOKS,
      row: 0,
      col: 0,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.WEBHOOK_EVENTS_PER_MINUTE,
      description: 'Count of webhook_events per minute',
      display: 'line',
      sql: "select date_trunc('minute', received_at) as minute, count(*) as events\nfrom webhook_events\nwhere received_at > now() - interval '2 hours'\ngroup by 1\norder by 1",
    },
    {
      tab: TAB_NAMES.WEBHOOKS,
      row: 0,
      col: 12,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.PARSE_VALIDITY,
      description: 'Valid vs invalid payloads',
      display: 'bar',
      sql: "select case when error is null then 'valid' else 'invalid' end as validity, count(*) as events\nfrom webhook_events\ngroup by 1\norder by 1",
    },
    {
      tab: TAB_NAMES.WEBHOOKS,
      row: 6,
      col: 0,
      sizeX: 12,
      sizeY: 6,
      name: CARD_NAMES.WEBHOOK_EVENTS_BY_TYPE,
      description: 'Count of webhook_events grouped by event_type',
      display: 'bar',
      sql: "select coalesce(event_type, '(none)') as event_type, count(*) as events\nfrom webhook_events\nwhere received_at > now() - interval '2 hours'\ngroup by 1\norder by events desc\nlimit 20",
    },
    {
      tab: TAB_NAMES.WEBHOOKS,
      row: 12,
      col: 0,
      sizeX: 24,
      sizeY: 8,
      name: CARD_NAMES.LATEST_WEBHOOK_EVENTS,
      description: 'Most recent webhook_events',
      display: 'table',
      sql: 'select received_at, event_type, request_ip, body_sha256, error\nfrom webhook_events\norder by received_at desc\nlimit 50',
    },
  ];

  const cardIdByName = new Map();
  for (const card of cards) {
    cardIdByName.set(
      card.name,
      await ensureCard(sessionId, {
        collectionId,
        databaseId,
        name: card.name,
        description: card.description,
        display: card.display,
        sql: card.sql,
        templateTags: card.templateTags,
        visualizationSettings: card.visualizationSettings,
      }),
    );
  }

  const dashboardId = await ensureDashboard(sessionId, {
    collectionId,
    name: DASHBOARD_NAME,
    description: DASHBOARD_DESCRIPTION,
  });

  const propertyTypeParamIdCandidate = randomUUID();
  let propertyTypeParamId = null;
  try {
    propertyTypeParamId = await ensurePropertyTypeDashboardFilter(sessionId, dashboardId, {
      collectionId,
      desiredId: propertyTypeParamIdCandidate,
    });
  } catch (err) {
    console.log(
      `[metabase-bootstrap] Warning: unable to configure property_type filter: ${String(err)}`,
    );
  }

  const transactionTypeParamIdCandidate = randomUUID();
  let transactionTypeParamId = null;
  try {
    transactionTypeParamId = await ensureTransactionTypeDashboardFilter(sessionId, dashboardId, {
      collectionId,
      desiredId: transactionTypeParamIdCandidate,
    });
  } catch (err) {
    console.log(
      `[metabase-bootstrap] Warning: unable to configure transaction_type filter: ${String(err)}`,
    );
  }

  const parameterMappingsByCardId = new Map();
  const transactionTypeMapping = (cardId) =>
    typeof transactionTypeParamId === 'string' && transactionTypeParamId.trim() !== ''
      ? {
          parameter_id: transactionTypeParamId,
          card_id: cardId,
          target: ['variable', ['template-tag', TEMPLATE_TAGS.TRANSACTION_TYPE]],
        }
      : null;

  const propertyTypeMapping = (cardId) =>
    typeof propertyTypeParamId === 'string' && propertyTypeParamId.trim() !== ''
      ? {
          parameter_id: propertyTypeParamId,
          card_id: cardId,
          target: ['variable', ['template-tag', TEMPLATE_TAGS.PROPERTY_TYPE]],
        }
      : null;

  const mappingsForCard = (cardId, { transactionType = false, propertyType = false } = {}) => {
    const mappings = [];
    if (transactionType) {
      const mapping = transactionTypeMapping(cardId);
      if (mapping) mappings.push(mapping);
    }
    if (propertyType) {
      const mapping = propertyTypeMapping(cardId);
      if (mapping) mappings.push(mapping);
    }
    return mappings;
  };

  const byDeptCardId = cardIdByName.get(CARD_NAMES.CLASSIFIEDS_BY_DEPARTMENT);
  if (typeof byDeptCardId === 'number') {
    const mappings = mappingsForCard(byDeptCardId, { transactionType: true, propertyType: true });
    if (mappings.length > 0) parameterMappingsByCardId.set(byDeptCardId, mappings);
  }

  const avgPriceCardId = cardIdByName.get(CARD_NAMES.AVG_PRICE_BY_DEPARTMENT);
  if (typeof avgPriceCardId === 'number') {
    const mappings = mappingsForCard(avgPriceCardId, { transactionType: true, propertyType: true });
    if (mappings.length > 0) parameterMappingsByCardId.set(avgPriceCardId, mappings);
  }

  const byTypeCardId = cardIdByName.get(CARD_NAMES.CLASSIFIEDS_BY_TYPE);
  if (typeof byTypeCardId === 'number') {
    const mappings = mappingsForCard(byTypeCardId, { propertyType: true });
    if (mappings.length > 0) parameterMappingsByCardId.set(byTypeCardId, mappings);
  }

  const duplicatedPropsCardId = cardIdByName.get(CARD_NAMES.DUPLICATED_PROPERTIES_BY_SOURCE_DOMAIN);
  if (typeof duplicatedPropsCardId === 'number') {
    const mappings = mappingsForCard(duplicatedPropsCardId, {
      transactionType: true,
      propertyType: true,
    });
    if (mappings.length > 0) parameterMappingsByCardId.set(duplicatedPropsCardId, mappings);
  }

  await setDashboardTabsAndCards(sessionId, dashboardId, {
    tabs: [TAB_NAMES.CLASSIFIEDS, TAB_NAMES.PROPERTIES, TAB_NAMES.WEBHOOKS],
    cards: cards.map((c) => ({
      tab: c.tab,
      cardId: cardIdByName.get(c.name),
      row: c.row,
      col: c.col,
      sizeX: c.sizeX,
      sizeY: c.sizeY,
    })),
    parameterMappingsByCardId,
  });

  if (typeof propertyTypeParamId === 'string' && propertyTypeParamId.trim() !== '') {
    try {
      await ensurePropertyTypeDashboardFilter(sessionId, dashboardId, {
        collectionId,
        desiredId: propertyTypeParamId,
      });
    } catch (err) {
      console.log(
        `[metabase-bootstrap] Warning: unable to persist property_type filter: ${String(err)}`,
      );
    }
  }

  if (typeof transactionTypeParamId === 'string' && transactionTypeParamId.trim() !== '') {
    try {
      await ensureTransactionTypeDashboardFilter(sessionId, dashboardId, {
        collectionId,
        desiredId: transactionTypeParamId,
      });
    } catch (err) {
      console.log(
        `[metabase-bootstrap] Warning: unable to persist transaction_type filter: ${String(err)}`,
      );
    }
  }

  await setCustomHomepage(sessionId, dashboardId);
  await enablePublicSharing(sessionId);
  const publicUuid = await ensurePublicDashboardLink(sessionId, dashboardId);

  console.log(`[metabase-bootstrap] Dashboard ready: /dashboard/${dashboardId}`);
  console.log(`[metabase-bootstrap] Public dashboard: /public/dashboard/${publicUuid}`);
}

await main();
