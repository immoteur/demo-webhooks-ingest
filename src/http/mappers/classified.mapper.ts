import type {
  Classified,
  MediaImage,
  TransactionPriceHistoryEntry,
} from '../../generated/schemas.js';
import type {
  ClassifiedImageRowInsert,
  ClassifiedPriceHistoryRowInsert,
} from '../../modules/classifieds/classified.dto.js';
import type { ClassifiedUpsertDto } from '../../modules/classifieds/classified.dto.js';

export function mapClassifiedToUpsertDto(input: {
  provider: string;
  classified: Classified;
  notificationType: string | null;
  webhookEventId: string;
  receivedAt: Date;
}): ClassifiedUpsertDto {
  const c = input.classified;

  const id = c.id;
  const propertyId = c.propertyId;
  const publishedAt = c.publishedAt ? new Date(c.publishedAt) : null;

  return {
    classified: {
      id,
      provider: input.provider,
      notificationType: input.notificationType,
      lastWebhookEventId: input.webhookEventId,
      lastReceivedAt: input.receivedAt,

      propertyId,
      currency: c.currency,
      squareUnit: c.squareUnit,
      publishedAt,
      title: c.title ?? null,
      description: c.description ?? null,

      statusCurrent: c.status.current,

      metaFirstSeenAt: new Date(c.meta.firstSeenAt),
      metaLastModifiedAt: new Date(c.meta.lastModifiedAt),
      metaLastSeenAt: new Date(c.meta.lastSeenAt),
      metaRemovedAt: c.meta.removedAt ? new Date(c.meta.removedAt) : null,

      sourceDomain: c.source.domain,
      sourceUrl: c.source.url,

      publisherIsProfessional: c.publisher.isProfessional,
      publisherType: c.publisher.type ?? null,
      publisherEmail: c.publisher.email ?? null,
      publisherPhone: c.publisher.phone ?? null,
      publisherFeesUrl: c.publisher.feesUrl ?? null,
      publisherSiren: c.publisher.siren ?? null,
      publisherSiret: c.publisher.siret ?? null,

      contactName: c.contact?.name ?? null,
      contactEmail: c.contact?.email ?? null,
      contactPhone: c.contact?.phone ?? null,

      locationCityName: c.location.city.name,
      locationCityInseeCode: c.location.city.inseeCode,
      locationCountry: c.location.country,
      locationDepartment: c.location.department,
      locationPostcode: c.location.postcode,
      locationLatitude: c.location.latitude ?? null,
      locationLongitude: c.location.longitude ?? null,

      propertyType: c.property.type,
      propertyArea: c.property.area ?? null,
      propertyRoomCount: c.property.roomCount ?? null,
      propertyBedroomCount: c.property.bedroomCount ?? null,
      propertyBathroomCount: c.property.bathroomCount ?? null,
      propertyShowerRoomCount: c.property.showerRoomCount ?? null,
      propertyToiletCount: c.property.toiletCount ?? null,
      propertyFloor: c.property.floor ?? null,
      propertyFloorCount: c.property.floorCount ?? null,
      propertyConstructionYear: c.property.constructionYear ?? null,
      propertyRenovationYear: c.property.renovationYear ?? null,
      propertyBalconyArea: c.property.balconyArea ?? null,
      propertyBalconyCount: c.property.balconyCount ?? null,
      propertyTerraceArea: c.property.terraceArea ?? null,
      propertyTerraceCount: c.property.terraceCount ?? null,
      propertyLandArea: c.property.landArea ?? null,
      propertyLivingRoomArea: c.property.livingRoomArea ?? null,
      propertyOrientation: c.property.orientation ?? null,

      propertyAirConditioningExists: c.property.airConditioningExists ?? null,
      propertyAlarmExists: c.property.alarmExists ?? null,
      propertyAtticExists: c.property.atticExists ?? null,
      propertyBalconyExists: c.property.balconyExists ?? null,
      propertyCaretakerExists: c.property.caretakerExists ?? null,
      propertyCellarExists: c.property.cellarExists ?? null,
      propertyDoorCodeExists: c.property.doorCodeExists ?? null,
      propertyElevatorExists: c.property.elevatorExists ?? null,
      propertyFireplaceExists: c.property.fireplaceExists ?? null,
      propertyGarageExists: c.property.garageExists ?? null,
      propertyGardenExists: c.property.gardenExists ?? null,
      propertyIntercomExists: c.property.intercomExists ?? null,
      propertyIsCondominium: c.property.isCondominium ?? null,
      propertyIsDisabledFriendly: c.property.isDisabledFriendly ?? null,
      propertyIsDualAspect: c.property.isDualAspect ?? null,
      propertyIsNew: c.property.isNew ?? null,
      propertyIsOccupied: c.property.isOccupied ?? null,
      propertyParkingExists: c.property.parkingExists ?? null,
      propertyRenovationIsNeeded: c.property.renovationIsNeeded ?? null,
      propertySwimmingPoolExists: c.property.swimmingPoolExists ?? null,
      propertyTerraceExists: c.property.terraceExists ?? null,
      propertyToiletSeparateExists: c.property.toiletSeparateExists ?? null,

      transactionType: c.transaction.type,
      transactionPriceCurrent: c.transaction.price.current,
      transactionPriceInitial: c.transaction.price.initial,
      transactionPricePerSquareUnit: c.transaction.price.perSquareUnit ?? null,

      energyDpeDate: c.energy?.dpe?.date ?? null,
      energyDpeLabel: c.energy?.dpe?.label ?? null,
      energyDpeValue: c.energy?.dpe?.value ?? null,
      energyGesDate: c.energy?.ges?.date ?? null,
      energyGesLabel: c.energy?.ges?.label ?? null,
      energyGesValue: c.energy?.ges?.value ?? null,
      energyHeatingSource: c.energy?.heating?.source ?? null,
      energyHeatingSystem: c.energy?.heating?.system ?? null,
      energyHeatingType: c.energy?.heating?.type ?? null,
    },
    images: toImageRows(id, c.media?.images ?? []),
    priceHistory: toPriceHistoryRows(id, c.transaction.price.history),
  };
}

function toImageRows(classifiedId: string, images: MediaImage[]): ClassifiedImageRowInsert[] {
  const rows: ClassifiedImageRowInsert[] = [];

  const seenIds = new Set<string>();
  const seenPositions = new Set<number>();

  for (const img of images) {
    const imageId = img.id;
    const position = img.position;

    if (seenIds.has(imageId) || seenPositions.has(position)) continue;
    seenIds.add(imageId);
    seenPositions.add(position);

    rows.push({
      classifiedId,
      id: imageId,
      position,
      url: img.url,
      averageHash: img.averageHash ?? null,
      differenceHash: img.differenceHash ?? null,
      perceptualHash: img.perceptualHash ?? null,
    });
  }

  return rows;
}

function toPriceHistoryRows(
  classifiedId: string,
  history: TransactionPriceHistoryEntry[],
): ClassifiedPriceHistoryRowInsert[] {
  const rows: ClassifiedPriceHistoryRowInsert[] = [];
  const seenTimestamps = new Set<number>();

  for (const entry of history) {
    const timestamp = new Date(entry.timestamp);
    const key = timestamp.getTime();
    if (seenTimestamps.has(key)) continue;
    seenTimestamps.add(key);

    rows.push({ classifiedId, timestamp, value: entry.value });
  }

  return rows;
}
