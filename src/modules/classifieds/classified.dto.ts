import type { InferInsertModel } from 'drizzle-orm';

import type { classifiedImages, classifiedPriceHistory, classifieds } from '../../db/schema.js';

export type ClassifiedRowInsert = InferInsertModel<typeof classifieds>;
export type ClassifiedImageRowInsert = InferInsertModel<typeof classifiedImages>;
export type ClassifiedPriceHistoryRowInsert = InferInsertModel<typeof classifiedPriceHistory>;

export type ClassifiedUpsertDto = {
  classified: ClassifiedRowInsert;
  images: ClassifiedImageRowInsert[];
  priceHistory: ClassifiedPriceHistoryRowInsert[];
};
