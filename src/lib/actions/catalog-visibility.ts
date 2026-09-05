"use server";

import { revalidateUser } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { compatDiff } from "@/lib/validation/catalog";
import type { ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Sets a user's `CatalogVisibility` to exactly `hiddenSeriesCodes` +
 * `hiddenProductCodes`, diffing each set against what's currently stored
 * and only writing the delta — the same "send the full desired set, let the
 * action diff it" shape `setOptionCompatibility` (src/lib/actions/catalog.ts)
 * already uses for `OptionCompatibility`, reusing its `compatDiff` helper
 * directly (series and products are two independent diffs against the same
 * user, not one combined one — a series code and a product code never
 * collide, but keeping them separate avoids relying on that).
 *
 * Unknown codes in either array are silently ignored (mirrors
 * `setOptionCompatibility`): they simply don't resolve to an id and so are
 * never added.
 */
export async function setCatalogVisibility(
  userId: string,
  hiddenSeriesCodes: string[],
  hiddenProductCodes: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "User not found" };

  const [existingRows, matchedSeries, matchedProducts] = await Promise.all([
    db.catalogVisibility.findMany({
      where: { userId },
      include: { series: true, product: true },
    }),
    db.series.findMany({ where: { code: { in: hiddenSeriesCodes } } }),
    db.product.findMany({ where: { code: { in: hiddenProductCodes } } }),
  ]);

  const existingSeriesRows = existingRows.filter((r) => r.seriesId !== null);
  const existingProductRows = existingRows.filter((r) => r.productId !== null);

  const currentSeriesCodes = existingSeriesRows
    .map((r) => r.series?.code)
    .filter((code): code is string => Boolean(code));
  const currentProductCodes = existingProductRows
    .map((r) => r.product?.code)
    .filter((code): code is string => Boolean(code));

  const submittedSeriesCodes = matchedSeries.map((s) => s.code);
  const submittedProductCodes = matchedProducts.map((p) => p.code);

  const seriesDiff = compatDiff(currentSeriesCodes, submittedSeriesCodes);
  const productDiff = compatDiff(currentProductCodes, submittedProductCodes);

  const seriesIdByCode = new Map(matchedSeries.map((s) => [s.code, s.id]));
  const productIdByCode = new Map(matchedProducts.map((p) => [p.code, p.id]));

  const removeIds = [
    ...existingSeriesRows.filter((r) => r.series && seriesDiff.toRemove.includes(r.series.code)).map((r) => r.id),
    ...existingProductRows.filter((r) => r.product && productDiff.toRemove.includes(r.product.code)).map((r) => r.id),
  ];

  await db.$transaction([
    ...(removeIds.length > 0
      ? [db.catalogVisibility.deleteMany({ where: { id: { in: removeIds } } })]
      : []),
    ...seriesDiff.toAdd.map((code) =>
      db.catalogVisibility.create({ data: { userId, seriesId: seriesIdByCode.get(code) } })
    ),
    ...productDiff.toAdd.map((code) =>
      db.catalogVisibility.create({ data: { userId, productId: productIdByCode.get(code) } })
    ),
  ]);

  // Catalogue visibility lives on the user's own settings page now (see
  // "feat: settings gets its own navigation") — there is no longer a
  // separate /settings/catalog-visibility route to revalidate.
  revalidateUser(user.id);
  return {};
}
