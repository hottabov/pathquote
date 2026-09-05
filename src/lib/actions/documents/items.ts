"use server";

/**
 * The item list itself: adding a product to a draft as a snapshotted
 * `DocumentItem`, removing one, and reordering the list. What an item then
 * carries — its options, its price, its display flags — is each a sibling
 * module.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { recalcAndEnforce } from "@/lib/documents/recalc";
import { catalogVisibilityUserId, isProductHidden } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { idSchema, isPermutation, reorderSchema } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import { assertStillDraft, mapDraftWriteError, type ActionResult } from "./_internal";

/**
 * Adds a product to a draft as a new DocumentItem, snapshotting its
 * code/name/description/price/image at the moment it's added (later catalog
 * edits never retroactively change an existing document — see schema
 * comments on DocumentItem). Requires a usable price (a Price row that
 * exists and isn't `needsReview`) for the document's own region; otherwise
 * returns an error naming the product and region rather than silently
 * adding a $0 line.
 *
 * Also rejects a product hidden from the caller's own user id via
 * `CatalogVisibility` (directly, or because its whole series is hidden) —
 * the *server-side* half of catalogue visibility: the item picker
 * (`getItemPickerCatalog`) already never offers a hidden product, but this
 * is the actual gate, since a crafted request can call this action with any
 * `productCode` regardless of what the picker rendered. Same "Product not
 * found" message as a genuinely nonexistent code — a hidden product must
 * read as *absent*, not as a product that exists but is refused (Ross: "we
 * don't want him to even see the Excalibur", not "let him see it's there
 * and blocked"). An ADMIN always resolves to no hidden ids (see
 * `catalogVisibilityUserId`) and so is never affected by this check.
 */
export async function addItem(documentId: string, productCode: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };
  const code = productCode.trim();
  if (!code) return { error: "Product not found" };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    include: { region: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const product = await db.product.findUnique({
    where: { code },
    include: { prices: { where: { regionId: document.regionId } } },
  });
  if (!product) return { error: "Product not found" };

  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session.user));
  if (isProductHidden(product, hiddenCatalogIds)) return { error: "Product not found" };

  const price = product.prices[0];
  if (!price || price.needsReview) {
    return { error: `Price required for ${product.code} in ${document.region.code}` };
  }

  // Atomically read max sortOrder, create the item, and recompute totals in
  // a single transaction: an item's price is always positive so this can
  // never actually push the subtotal negative, but every mutation here goes
  // through the same guarded pattern (see `NegativeSubtotalError`) rather
  // than special-casing "safe" ones. Interactive transaction also still
  // ensures the aggregate(max) and create are not interleaved with other
  // writes.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      const maxSortOrder = await tx.documentItem.aggregate({
        where: { documentId: document.id },
        _max: { sortOrder: true },
      });

      await tx.documentItem.create({
        data: {
          documentId: document.id,
          productId: product.id,
          sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
          code: product.code,
          name: product.name,
          description: product.description,
          unitPrice: price.amount,
          // Snapshot the catalogue price alongside unitPrice — a fresh item
          // starts identical to its list price (no concession) until a
          // salesperson hand-edits it via `setItemUnitPrice`.
          listPrice: price.amount,
          imageUrl: product.imageUrl,
          // Quotation-first default (behavior change): a newly added item with a
          // product image starts with its image already switched on for display
          // — the owner's quotes almost always show it (full-width, right under
          // the product title — see quotation-sheet.tsx), so requiring an extra
          // manual toggle on every single item added defeats the point. Still
          // author-togglable afterwards via `setItemShowImage`, and a product
          // with no image simply has nothing to default on (`false` either way).
          showImage: Boolean(product.imageUrl),
        },
      });

      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/** Removes an item (and its lines, via cascade) from a draft. Scoped
 * through the item -> document -> author chain, not just the item id, so a
 * foreign item id can never be deleted by guessing/enumerating ids. */
export async function removeItem(itemId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  // Removing an item can reveal a negative subtotal (a trade-in extra line
  // that was previously offset by this item's price) — same guarded
  // transaction pattern as every other mutation here. Removing an item can
  // also *raise* the document's concession percentage (it shrinks
  // `listValue` while any remaining concession stays the same), so the cap
  // is re-checked here too.
  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, item.documentId);
      await tx.documentItem.delete({ where: { id: item.id } });
      concessionWarning = (await recalcAndEnforce(item.documentId, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(item.documentId);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/**
 * Reorders a draft's items to match `orderedItemIds`, writing each item's
 * new `sortOrder` as its index in that array. `orderedItemIds` must be a
 * permutation of the document's own item ids (same set, no dupes, none
 * missing, none foreign) — checked via `isPermutation` against the item ids
 * actually loaded under `documentWhereForUser` scope, so a foreign or
 * stale id can never sneak an item from another document into this one's
 * order, and a client that lost track of an item (e.g. a stale tab) gets
 * rejected instead of silently dropping it. Every `documentItem.update` in
 * the list runs in one `$transaction` so a partial reorder is never
 * persisted. No totals recompute — reordering never changes what's owed
 * (unlike every other mutation in this directory, all of which move
 * price-affecting state and so end in `recalcAndEnforce`).
 */
export async function reorderItems(documentId: string, orderedItemIds: string[]): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedOrder = reorderSchema.safeParse(orderedItemIds);
  if (!parsedOrder.success) return { error: flattenZodError(parsedOrder.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
    include: { items: { select: { id: true } } },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const actualItemIds = document.items.map((item) => item.id);
  if (!isPermutation(parsedOrder.data, actualItemIds)) {
    return { error: "Item list doesn't match — refresh and try again" };
  }

  // An interactive transaction rather than the batch `$transaction([...])`
  // this used to be, purely so the draft guard can read its own `count` before
  // the updates run — a batch has no way to inspect one.
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      for (const [index, itemId] of parsedOrder.data.entries()) {
        await tx.documentItem.update({ where: { id: itemId }, data: { sortOrder: index } });
      }
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return {};
}
