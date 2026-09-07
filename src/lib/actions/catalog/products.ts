"use server";

import { revalidateCatalog, revalidateProduct } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import {
  productSchema,
  reorderProductsSchema,
  isProductPermutation,
} from "@/lib/validation/catalog";
import { sanitizeIfHtml } from "@/lib/rich-text";
import { CODE_EXISTS_ERROR, flattenZodError, type ActionResult } from "../_shared";
import { isUniqueConstraintError, readProductForm } from "./_internal";

/** `Product.description` is now written by the `RichTextEditor`
 * (product-form.tsx), same HTML-storage story as `QuoteDocument.body` — see
 * `sanitizeIfHtml`'s doc comment. `parsed.data.description` is `undefined`
 * when the field was left blank (see `descriptionSchema` in
 * validation/catalog.ts), which becomes `null` on the row exactly as before. */
function sanitizeProductDescription(description: string | undefined): string | null {
  return description === undefined ? null : sanitizeIfHtml(description);
}

export async function createProduct(seriesId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = productSchema.safeParse(readProductForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const series = await db.series.findUnique({ where: { id: seriesId } });
  if (!series) {
    return { error: "Series not found" };
  }

  let created;
  try {
    created = await db.product.create({
      data: {
        code: parsed.data.code,
        seriesId: series.id,
        name: parsed.data.name,
        description: sanitizeProductDescription(parsed.data.description),
        active: parsed.data.active,
        noCommission: parsed.data.noCommission,
        sortOrder: parsed.data.sortOrder,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: CODE_EXISTS_ERROR };
    throw error;
  }

  revalidateCatalog(series.id);
  redirect(`/catalog/${series.id}/${created.id}`);
}

export async function updateProduct(productId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = productSchema.safeParse(readProductForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const existing = await db.product.findUnique({
    where: { id: productId },
    include: { series: true },
  });
  if (!existing) return { error: "Product not found" };

  try {
    await db.product.update({
      where: { id: productId },
      data: {
        code: parsed.data.code,
        name: parsed.data.name,
        description: sanitizeProductDescription(parsed.data.description),
        active: parsed.data.active,
        noCommission: parsed.data.noCommission,
        sortOrder: parsed.data.sortOrder,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: CODE_EXISTS_ERROR };
    throw error;
  }

  // The route is keyed by id, which never changes on an update, so unlike
  // the code-keyed revalidation this replaced there's no "old code path" /
  // "new code path" pair to worry about here — just the one URL (same
  // simplification `updateOption` made when its route moved to id).
  revalidateCatalog();
  revalidateProduct(existing.series.id, productId);
  redirect(`/catalog/${existing.series.id}/${productId}`);
}

export async function deleteProduct(productId: string): Promise<ActionResult> {
  await requireAdmin();

  const existing = await db.product.findUnique({
    where: { id: productId },
    include: { series: true },
  });
  if (!existing) return { error: "Product not found" };

  const [referencedCount, referencedLineCount] = await Promise.all([
    db.documentItem.count({ where: { productId } }),
    db.documentLine.count({ where: { refId: productId, kind: "PRODUCT" } }),
  ]);
  if (referencedCount > 0 || referencedLineCount > 0) {
    return { error: "This product is used on one or more documents and can't be deleted." };
  }

  // Price rows cascade (Price.productId is onDelete: Cascade in the schema).
  await db.product.delete({ where: { id: productId } });

  revalidateCatalog(existing.series.id);
  redirect(`/catalog/${existing.series.id}`);
}

/**
 * Reorders a series' products to match `orderedProductIds`, writing each
 * product's new `sortOrder` as its index in that array — same "reindex the
 * whole list in one transaction" shape `reorderItems` uses for the
 * builder's items (src/lib/actions/documents.ts). Reindexing every product
 * in the series (not just the ones that moved) is what keeps a
 * half-touched series from reading wrong afterwards: `seriesProductsResult`
 * orders by `sortOrder` then `code`, so if only the dragged product got a
 * new `sortOrder` while everything else stayed at the default `0`, the
 * dragged one would either jump to the very front (a low index) or the
 * untouched majority would keep tying at `0` while one product floats at
 * some arbitrary higher number — neither reads as "the order I dragged".
 * Writing 0..n-1 across the *entire* series after every drag guarantees the
 * list always matches exactly what was submitted, immediately.
 *
 * `orderedProductIds` must be a permutation of the series' own product ids
 * (checked via `isProductPermutation`, same pattern `reorderItems` uses
 * against `isPermutation`) so a stale or foreign id can't sneak a product
 * from another series into this one's order.
 */
export async function reorderProducts(seriesId: string, orderedProductIds: string[]): Promise<ActionResult> {
  await requireAdmin();

  const parsedOrder = reorderProductsSchema.safeParse(orderedProductIds);
  if (!parsedOrder.success) return { error: flattenZodError(parsedOrder.error) };

  const series = await db.series.findUnique({
    where: { id: seriesId },
    include: { products: { select: { id: true } } },
  });
  if (!series) return { error: "Series not found" };

  const actualProductIds = series.products.map((p) => p.id);
  if (!isProductPermutation(parsedOrder.data, actualProductIds)) {
    return { error: "Product list doesn't match — refresh and try again" };
  }

  await db.$transaction(
    parsedOrder.data.map((productId, index) =>
      db.product.update({ where: { id: productId }, data: { sortOrder: index } })
    )
  );

  revalidateCatalog(seriesId);
  return {};
}
