import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    requestIp: text('request_ip'),
    payload: jsonb('payload'),
    bodySha256: text('body_sha256').notNull(),
    error: text('error'),
  },
  (table) => ({
    receivedAtIdx: index('webhook_events_received_at_idx').on(table.receivedAt),
    receivedAtIdIdx: index('webhook_events_received_at_id_idx').on(table.receivedAt, table.id),
    eventTypeIdx: index('webhook_events_event_type_idx').on(table.eventType),
    receivedAtEventTypeIdx: index('webhook_events_received_at_event_type_idx').on(
      table.receivedAt,
      table.eventType,
    ),
  }),
);

export const classifieds = pgTable(
  'classifieds',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    notificationType: text('notification_type'),
    lastWebhookEventId: uuid('last_webhook_event_id')
      .notNull()
      .references(() => webhookEvents.id),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }).notNull().defaultNow(),

    propertyId: uuid('property_id').notNull(),
    currency: text('currency').notNull(),
    squareUnit: text('square_unit').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    title: text('title'),
    description: text('description'),

    statusCurrent: text('status_current').notNull(),

    metaFirstSeenAt: timestamp('meta_first_seen_at', { withTimezone: true }).notNull(),
    metaLastModifiedAt: timestamp('meta_last_modified_at', { withTimezone: true }).notNull(),
    metaLastSeenAt: timestamp('meta_last_seen_at', { withTimezone: true }).notNull(),
    metaRemovedAt: timestamp('meta_removed_at', { withTimezone: true }),

    sourceDomain: text('source_domain').notNull(),
    sourceUrl: text('source_url').notNull(),

    publisherIsProfessional: boolean('publisher_is_professional').notNull(),
    publisherType: text('publisher_type'),
    publisherEmail: text('publisher_email'),
    publisherPhone: text('publisher_phone'),
    publisherFeesUrl: text('publisher_fees_url'),
    publisherSiren: text('publisher_siren'),
    publisherSiret: text('publisher_siret'),

    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),

    locationCityName: text('location_city_name').notNull(),
    locationCityInseeCode: text('location_city_insee_code').notNull(),
    locationCountry: text('location_country').notNull(),
    locationDepartment: text('location_department').notNull(),
    locationPostcode: text('location_postcode').notNull(),
    locationLatitude: doublePrecision('location_latitude'),
    locationLongitude: doublePrecision('location_longitude'),

    propertyType: text('property_type').notNull(),
    propertyArea: real('property_area'),
    propertyRoomCount: integer('property_room_count'),
    propertyBedroomCount: integer('property_bedroom_count'),
    propertyBathroomCount: integer('property_bathroom_count'),
    propertyShowerRoomCount: integer('property_shower_room_count'),
    propertyToiletCount: integer('property_toilet_count'),
    propertyFloor: integer('property_floor'),
    propertyFloorCount: integer('property_floor_count'),
    propertyConstructionYear: integer('property_construction_year'),
    propertyRenovationYear: integer('property_renovation_year'),
    propertyBalconyArea: real('property_balcony_area'),
    propertyBalconyCount: integer('property_balcony_count'),
    propertyTerraceArea: real('property_terrace_area'),
    propertyTerraceCount: integer('property_terrace_count'),
    propertyLandArea: real('property_land_area'),
    propertyLivingRoomArea: real('property_living_room_area'),
    propertyOrientation: text('property_orientation'),

    propertyAirConditioningExists: boolean('property_air_conditioning_exists'),
    propertyAlarmExists: boolean('property_alarm_exists'),
    propertyAtticExists: boolean('property_attic_exists'),
    propertyBalconyExists: boolean('property_balcony_exists'),
    propertyCaretakerExists: boolean('property_caretaker_exists'),
    propertyCellarExists: boolean('property_cellar_exists'),
    propertyDoorCodeExists: boolean('property_door_code_exists'),
    propertyElevatorExists: boolean('property_elevator_exists'),
    propertyFireplaceExists: boolean('property_fireplace_exists'),
    propertyGarageExists: boolean('property_garage_exists'),
    propertyGardenExists: boolean('property_garden_exists'),
    propertyIntercomExists: boolean('property_intercom_exists'),
    propertyIsCondominium: boolean('property_is_condominium'),
    propertyIsDisabledFriendly: boolean('property_is_disabled_friendly'),
    propertyIsDualAspect: boolean('property_is_dual_aspect'),
    propertyIsNew: boolean('property_is_new'),
    propertyIsOccupied: boolean('property_is_occupied'),
    propertyParkingExists: boolean('property_parking_exists'),
    propertyRenovationIsNeeded: boolean('property_renovation_is_needed'),
    propertySwimmingPoolExists: boolean('property_swimming_pool_exists'),
    propertyTerraceExists: boolean('property_terrace_exists'),
    propertyToiletSeparateExists: boolean('property_toilet_separate_exists'),

    transactionType: text('transaction_type').notNull(),
    transactionPriceCurrent: integer('transaction_price_current').notNull(),
    transactionPriceInitial: integer('transaction_price_initial').notNull(),
    transactionPricePerSquareUnit: integer('transaction_price_per_square_unit'),

    energyDpeDate: date('energy_dpe_date'),
    energyDpeLabel: text('energy_dpe_label'),
    energyDpeValue: integer('energy_dpe_value'),
    energyGesDate: date('energy_ges_date'),
    energyGesLabel: text('energy_ges_label'),
    energyGesValue: integer('energy_ges_value'),
    energyHeatingSource: text('energy_heating_source'),
    energyHeatingSystem: text('energy_heating_system'),
    energyHeatingType: text('energy_heating_type'),
  },
  (table) => ({
    propertyIdIdx: index('classifieds_property_id_idx').on(table.propertyId),
    statusCurrentIdx: index('classifieds_status_current_idx').on(table.statusCurrent),
    locationDepartmentIdx: index('classifieds_location_department_idx').on(
      table.locationDepartment,
    ),
    lastReceivedAtIdx: index('classifieds_last_received_at_idx').on(table.lastReceivedAt),
    lastReceivedAtIdIdx: index('classifieds_last_received_at_id_idx').on(
      table.lastReceivedAt,
      table.id,
    ),
    metaLastSeenAtIdx: index('classifieds_meta_last_seen_at_idx').on(table.metaLastSeenAt),
    lastWebhookEventIdIdx: index('classifieds_last_webhook_event_id_idx').on(
      table.lastWebhookEventId,
    ),
    propertyTypeTransactionTypeIdx: index('classifieds_property_type_transaction_type_idx').on(
      table.propertyType,
      table.transactionType,
    ),
    transactionTypeLocationDepartmentIdx: index(
      'classifieds_transaction_type_location_department_idx',
    ).on(table.transactionType, table.locationDepartment),
    transactionTypePropertyTypeLocationDepartmentIdx: index(
      'classifieds_transaction_type_property_type_location_department_idx',
    ).on(table.transactionType, table.propertyType, table.locationDepartment),
    propertyIdSourceDomainIdx: index('classifieds_property_id_source_domain_idx').on(
      table.propertyId,
      table.sourceDomain,
    ),
    propertyIdLastReceivedAtIdx: index('classifieds_property_id_last_received_at_idx').on(
      table.propertyId,
      table.lastReceivedAt,
    ),
  }),
);

export const classifiedImages = pgTable(
  'classified_images',
  {
    classifiedId: uuid('classified_id')
      .notNull()
      .references(() => classifieds.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    position: integer('position').notNull(),
    url: text('url').notNull(),
    averageHash: text('average_hash'),
    differenceHash: text('difference_hash'),
    perceptualHash: text('perceptual_hash'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.classifiedId, table.id] }),
    classifiedPositionUnique: uniqueIndex('classified_images_classified_position_uniq').on(
      table.classifiedId,
      table.position,
    ),
    classifiedPositionIdx: index('classified_images_classified_position_idx').on(
      table.classifiedId,
      table.position,
    ),
  }),
);

export const classifiedPriceHistory = pgTable(
  'classified_price_history',
  {
    classifiedId: uuid('classified_id')
      .notNull()
      .references(() => classifieds.id, { onDelete: 'cascade' }),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    value: integer('value').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.classifiedId, table.timestamp] }),
    classifiedTimestampIdx: index('classified_price_history_classified_timestamp_idx').on(
      table.classifiedId,
      table.timestamp,
    ),
  }),
);
