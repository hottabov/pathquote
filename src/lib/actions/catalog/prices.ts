"use server";

import { revalidateOption, revalidateOptionList, revalidateProduct } from "@/lib/revalidate";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { priceInputSchema } from "@/lib/validation/catalog";
import { flattenZodError, type ActionResult } from "../_shared";
import { isProductPriceTarget, type PriceTarget } from "./_internal";

export async function upsertPrice(target: PriceTarget, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = priceInputSchema.safeParse({
    regionCode: formData.get("regionCode"),
    amount: formData.get("amount"),
  });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const region = await db.region.findUnique({ where: { code: parsed.data.regionCode } });
  if (!region) return { error: "Region not found" };

  if (parsed.data.amount === "") {
    // Empty amount clears the price row entirely.
    if (isProductPriceTarget(target)) {
      await db.price.deleteMany({ where: { productId: target.productId, regionId: region.id } });
    } else {
      await db.price.deleteMany({ where: { optionId: target.optionId, regionId: region.id } });
    }
  } else {
    const amount = new Prisma.Decimal(parsed.data.amount);
    if (isProductPriceTarget(target)) {
      await db.price.upsert({
        where: { productId_regionId: { productId: target.productId, regionId: region.id } },
        create: { productId: target.productId, regionId: region.id, amount, needsReview: false },
        update: { amount, needsReview: false },
      });
    } else {
      await db.price.upsert({
        where: { optionId_regionId: { optionId: target.optionId, regionId: region.id } },
        create: { optionId: target.optionId, regionId: region.id, amount, needsReview: false },
        update: { amount, needsReview: false },
      });
    }
  }

  if (isProductPriceTarget(target)) {
    // Both route segments are ids now, but `target` only carries the
    // product's -- the series' id still needs a lookup to build the path
    // (unlike the option branch below, where the route has just the one id
    // and `target` already carries it).
    //
    // The catalogue index is deliberately *not* revalidated here, unlike in
    // `updateProductImage`: a series card shows a name, a code, a product
    // count and an image, none of which a price can move.
    const product = await db.product.findUnique({
      where: { id: target.productId },
      include: { series: true },
    });
    if (product) {
      revalidateProduct(product.series.id, product.id);
    }
  } else {
    revalidateOption(target.optionId);
    revalidateOptionList();
  }

  return {};
}
