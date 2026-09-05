"use server";

import { revalidateOption, revalidateOptionList } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { compatDiff } from "@/lib/validation/catalog";
import type { ActionResult } from "../_shared";

/**
 * Sets an option's series-level compatibility to exactly `seriesCodes`,
 * diffing against what's currently stored and only writing the delta.
 * Product-level compatibility rows (out of phase-3 scope) are left alone.
 * Unknown codes in `seriesCodes` are silently ignored (they simply don't
 * resolve to a series id and so are never added).
 */
export async function setOptionCompatibility(
  optionId: string,
  seriesCodes: string[]
): Promise<ActionResult> {
  await requireAdmin();

  const option = await db.option.findUnique({ where: { id: optionId } });
  if (!option) return { error: "Option not found" };

  const [existingCompat, matchedSeries] = await Promise.all([
    db.optionCompatibility.findMany({
      where: { optionId, seriesId: { not: null }, productId: null },
      include: { series: true },
    }),
    db.series.findMany({ where: { code: { in: seriesCodes } } }),
  ]);

  const currentCodes = existingCompat
    .map((c) => c.series?.code)
    .filter((code): code is string => Boolean(code));
  const submittedCodes = matchedSeries.map((s) => s.code);
  const { toAdd, toRemove } = compatDiff(currentCodes, submittedCodes);

  const seriesIdByCode = new Map(matchedSeries.map((s) => [s.code, s.id]));
  const removeIds = existingCompat
    .filter((c) => c.series && toRemove.includes(c.series.code))
    .map((c) => c.id);

  await db.$transaction([
    ...(removeIds.length > 0
      ? [db.optionCompatibility.deleteMany({ where: { id: { in: removeIds } } })]
      : []),
    ...toAdd.map((code) =>
      db.optionCompatibility.create({
        data: { optionId, seriesId: seriesIdByCode.get(code) },
      })
    ),
  ]);

  revalidateOption(optionId);
  revalidateOptionList();
  return {};
}
