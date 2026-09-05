"use server";

import { revalidateOption, revalidateOptionList } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { compatDiff } from "@/lib/validation/catalog";
import type { ActionResult } from "../_shared";

/**
 * Sets an option's series-level compatibility to exactly `seriesIds`,
 * diffing against what's currently stored and only writing the delta.
 * Product-level compatibility rows (out of phase-3 scope) are left alone.
 * Series travel as ids, never codes -- a code is a label an admin can
 * rename while the editor is open (see
 * docs/plans/2026-09-05-catalog-identity-and-cleanup.md). Unknown ids in
 * `seriesIds` are silently ignored (they simply don't resolve to a series
 * row and so are never added).
 */
export async function setOptionCompatibility(
  optionId: string,
  seriesIds: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const option = await db.option.findUnique({ where: { id: optionId } });
  if (!option) return { error: "Option not found" };

  const [existingCompat, matchedSeries] = await Promise.all([
    db.optionCompatibility.findMany({
      where: { optionId, seriesId: { not: null }, productId: null },
      select: { id: true, seriesId: true },
    }),
    db.series.findMany({ where: { id: { in: seriesIds } }, select: { id: true } }),
  ]);

  const currentIds = existingCompat
    .map((c) => c.seriesId)
    .filter((id): id is string => id !== null);
  const submittedIds = matchedSeries.map((s) => s.id);
  const { toAdd, toRemove } = compatDiff(currentIds, submittedIds);

  const removeIds = existingCompat
    .filter((c) => c.seriesId !== null && toRemove.includes(c.seriesId))
    .map((c) => c.id);

  await db.$transaction([
    ...(removeIds.length > 0
      ? [db.optionCompatibility.deleteMany({ where: { id: { in: removeIds } } })]
      : []),
    ...toAdd.map((seriesId) => db.optionCompatibility.create({ data: { optionId, seriesId } })),
  ]);

  revalidateOption(optionId);
  revalidateOptionList();
  return {};
}
