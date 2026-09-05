"use server";

import {
  revalidateCatalog,
  revalidateOption,
  revalidateOptionList,
  revalidateProduct,
} from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { parseImageUrl, type ActionResult } from "../_shared";

export async function updateProductImage(productId: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();

  const parsed = parseImageUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  const existing = await db.product.findUnique({
    where: { id: productId },
    include: { series: true },
  });
  if (!existing) return { error: "Product not found" };

  await db.product.update({ where: { id: productId }, data: { imageUrl: parsed.value } });

  // The catalogue index is in scope too, even though nothing about the
  // series row itself changed: a series card with no `Series.imageUrl`
  // override shows the first active product that has an image
  // (listSeriesWithCounts/getSeriesFallbackImageUrl, queries/catalog.ts), so
  // setting an image can hand that series a card photo it didn't have, and
  // clearing one can take it away or promote the next product in order.
  // Which product currently supplies it isn't knowable from `productId`
  // alone, so revalidate the index on every image write rather than trying
  // to decide whether this particular one mattered.
  revalidateCatalog();
  revalidateProduct(existing.series.id, productId);
  return {};
}

export async function updateOptionImage(optionId: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();

  const parsed = parseImageUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  const existing = await db.option.findUnique({ where: { id: optionId } });
  if (!existing) return { error: "Option not found" };

  await db.option.update({ where: { id: optionId }, data: { imageUrl: parsed.value } });

  revalidateOption(optionId);
  revalidateOptionList();
  return {};
}

/** Sets (or clears, via `url: null`) a series' own catalog-card image
 * override. `null` isn't "no image" here -- it means "fall back to a
 * product image", see listSeriesWithCounts/getSeriesFallbackImageUrl in
 * src/lib/queries/catalog.ts -- but the persisted value and validation are
 * identical to updateProductImage/updateOptionImage above. */
export async function updateSeriesImage(seriesId: string, url: string | null): Promise<ActionResult> {
  await requireAdmin();

  const parsed = parseImageUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  const existing = await db.series.findUnique({ where: { id: seriesId } });
  if (!existing) return { error: "Series not found" };

  await db.series.update({ where: { id: seriesId }, data: { imageUrl: parsed.value } });

  // The route is keyed by id, which is already the parameter this action
  // takes -- no need for the `existing` lookup's code to build the path.
  revalidateCatalog(seriesId);
  return {};
}
