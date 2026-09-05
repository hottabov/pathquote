"use server";

import { revalidateUser } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { compatDiff } from "@/lib/validation/catalog";
import type { ActionResult } from "./_shared";

export type { ActionResult };

/**
 * Sets a user's `CatalogVisibility` to exactly `hiddenSeriesIds` +
 * `hiddenProductIds`, diffing each set against what's currently stored
 * and only writing the delta — the same "send the full desired set, let the
 * action diff it" shape `setOptionCompatibility` (src/lib/actions/catalog.ts)
 * already uses for `OptionCompatibility`, reusing its `compatDiff` helper
 * directly (series and products are two independent diffs against the same
 * user, not one combined one — a series id and a product id never
 * collide, but keeping them separate avoids relying on that).
 *
 * Series and products travel as ids, never codes: a code is a label an
 * admin can rename while this editor is open, and a rename must not turn a
 * saved "hidden" into a silent no-op (see
 * docs/plans/2026-09-05-catalog-identity-and-cleanup.md). Unknown ids in
 * either array are silently ignored (mirrors `setOptionCompatibility`):
 * they simply don't resolve to a row and so are never added.
 */
export async function setCatalogVisibility(
  userId: string,
  hiddenSeriesIds: string[],
  hiddenProductIds: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { error: "User not found" };

  const [existingRows, matchedSeries, matchedProducts] = await Promise.all([
    db.catalogVisibility.findMany({ where: { userId } }),
    db.series.findMany({ where: { id: { in: hiddenSeriesIds } }, select: { id: true } }),
    db.product.findMany({ where: { id: { in: hiddenProductIds } }, select: { id: true } }),
  ]);

  const existingSeriesRows = existingRows.filter(
    (r): r is typeof r & { seriesId: string } => r.seriesId !== null
  );
  const existingProductRows = existingRows.filter(
    (r): r is typeof r & { productId: string } => r.productId !== null
  );

  const seriesDiff = compatDiff(
    existingSeriesRows.map((r) => r.seriesId),
    matchedSeries.map((s) => s.id)
  );
  const productDiff = compatDiff(
    existingProductRows.map((r) => r.productId),
    matchedProducts.map((p) => p.id)
  );

  const removeIds = [
    ...existingSeriesRows.filter((r) => seriesDiff.toRemove.includes(r.seriesId)).map((r) => r.id),
    ...existingProductRows.filter((r) => productDiff.toRemove.includes(r.productId)).map((r) => r.id),
  ];

  await db.$transaction([
    ...(removeIds.length > 0
      ? [db.catalogVisibility.deleteMany({ where: { id: { in: removeIds } } })]
      : []),
    ...seriesDiff.toAdd.map((seriesId) => db.catalogVisibility.create({ data: { userId, seriesId } })),
    ...productDiff.toAdd.map((productId) =>
      db.catalogVisibility.create({ data: { userId, productId } })
    ),
  ]);

  // Catalogue visibility lives on the user's own settings page now (see
  // "feat: settings gets its own navigation") — there is no longer a
  // separate /settings/catalog-visibility route to revalidate.
  revalidateUser(user.id);
  return {};
}
