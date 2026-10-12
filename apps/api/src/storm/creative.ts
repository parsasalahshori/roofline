import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { storedFiles, stormPhotos, withTenant, type TenantContext } from '@roofline/db';
import type { AppDeps } from '../app.ts';

/** The line under the company name on the generated ad card. */
export const AD_CARD_LINE = 'Free roof check after the hail';
/** The card's background colour (the S1 blue). */
const AD_CARD_COLOR = '#1d4ed8';

export type AdImage = { bytes: Uint8Array; contentType: string; storedFileId: string };

/**
 * The picture for a storm ad: the company's chosen storm photo when it has one and its bytes are still
 * there, otherwise a generated card stored once per content hash as an 'ad_image' file (the same
 * pattern as the storm photos in routes/storm-settings.ts). The object is put outside any transaction.
 */
export async function resolveAdImage(
  deps: AppDeps,
  ctx: TenantContext,
  input: { companyName: string; photoId: string | null | undefined },
): Promise<AdImage> {
  if (input.photoId) {
    const photoId = input.photoId;
    const [file] = await withTenant(deps.pools, ctx, (tx) =>
      tx
        .select({ id: storedFiles.id, objectKey: storedFiles.objectKey, contentType: storedFiles.contentType })
        .from(stormPhotos)
        .innerJoin(
          storedFiles,
          and(eq(storedFiles.companyId, stormPhotos.companyId), eq(storedFiles.id, stormPhotos.storedFileId)),
        )
        .where(and(eq(stormPhotos.id, photoId), eq(stormPhotos.companyId, ctx.companyId)))
        .limit(1),
    );
    if (file) {
      const bytes = await deps.objectStore.get(file.objectKey);
      if (bytes !== null) return { bytes, contentType: file.contentType, storedFileId: file.id };
    }
  }

  const bytes = await deps.adImage.card({ companyName: input.companyName, line: AD_CARD_LINE, colorHex: AD_CARD_COLOR });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const objectKey = `ad-images/${ctx.companyId}/${sha256}.png`;

  const [existing] = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .select({ id: storedFiles.id })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, ctx.companyId), eq(storedFiles.kind, 'ad_image'), eq(storedFiles.sha256, sha256)))
      .limit(1),
  );
  if (existing) return { bytes, contentType: 'image/png', storedFileId: existing.id };

  await deps.objectStore.put(objectKey, bytes, 'image/png');
  const [row] = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .insert(storedFiles)
      .values({ companyId: ctx.companyId, kind: 'ad_image', objectKey, sha256, bytes: bytes.length, contentType: 'image/png' })
      .returning({ id: storedFiles.id }),
  );
  return { bytes, contentType: 'image/png', storedFileId: row!.id };
}
