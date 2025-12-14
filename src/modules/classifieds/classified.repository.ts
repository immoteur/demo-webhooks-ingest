import { eq } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { classifiedImages, classifiedPriceHistory, classifieds } from '../../db/schema.js';
import type { ClassifiedUpsertDto } from './classified.dto.js';

export async function upsertClassified(
  dto: ClassifiedUpsertDto,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(classifieds)
        .values(dto.classified)
        .onConflictDoUpdate({ target: classifieds.id, set: dto.classified });

      const classifiedId = dto.classified.id;

      await tx.delete(classifiedImages).where(eq(classifiedImages.classifiedId, classifiedId));
      if (dto.images.length > 0) {
        await tx
          .insert(classifiedImages)
          .values(dto.images.map((img) => ({ ...img, classifiedId })));
      }

      await tx
        .delete(classifiedPriceHistory)
        .where(eq(classifiedPriceHistory.classifiedId, classifiedId));
      if (dto.priceHistory.length > 0) {
        await tx
          .insert(classifiedPriceHistory)
          .values(dto.priceHistory.map((entry) => ({ ...entry, classifiedId })));
      }
    });

    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function upsertClassifieds(
  dtos: ClassifiedUpsertDto[],
): Promise<
  | { ok: true; failures: Array<{ classifiedId: string; error: unknown }> }
  | { ok: false; error: unknown }
> {
  try {
    const failures: Array<{ classifiedId: string; error: unknown }> = [];

    for (const dto of dtos) {
      const res = await upsertClassified(dto);
      if (!res.ok) failures.push({ classifiedId: dto.classified.id, error: res.error });
    }

    return { ok: true, failures };
  } catch (error) {
    return { ok: false, error };
  }
}
