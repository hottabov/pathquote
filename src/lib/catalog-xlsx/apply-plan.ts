/**
 * CatalogDiff -> the ordered list of writes that realise it. Pure: the
 * transaction in src/lib/actions/catalog-import.ts is a thin executor that
 * walks this list, resolving codes to ids as it goes, so the *decisions*
 * (what is written, in what order, what is deleted from which drafts) are
 * all testable here without a database.
 *
 * Order, and why:
 *
 *  1. Deletions first -- detach DRAFT references, then delete options, then
 *     products. Deleting before creating is what lets a director delete a
 *     row and add it back without its id (a new row with the old code): with
 *     creates first the unique `code` would collide with the row that is
 *     about to go. Safe for references because the parser already refuses a
 *     file that points at a product it deletes (parentProduct,
 *     compatProducts), and every other reference to a deleted row is either
 *     cascaded or nulled by the schema (Price, OptionCompatibility,
 *     CatalogVisibility, DocumentItem.product -- see prisma/schema.prisma).
 *  2. Release the codes of every renamed row to a temporary value, so a
 *     chain (A -> B, B -> C) or a swap (A <-> B) of unique codes cannot
 *     fail on whichever statement happens to run first.
 *  3. Products: create, update. Options: create, update (options may name a
 *     product created two steps earlier as parentProduct).
 *  4. Compatibility: replace the compat rows of every created option and of
 *     every updated option whose compat lists changed.
 *  5. Prices: upsert created/updated, delete deleted.
 *
 * DRAFT clean-up (step 1) is what the owner asked for: a draft that quoted a
 * deleted row loses that line and is recalculated (the executor collects the
 * affected document ids from the detach steps); FINAL documents are never
 * touched -- their items are snapshots.
 */
import type { CatalogDiff } from "./diff";
import type { ParsedCatalog, ParsedOption, ParsedProduct } from "./parse";
import type { ItemType } from "./columns";

/** How an op names a product/option: by database id, or -- for a row this
 * same plan creates -- by the file's code, resolved by the executor once the
 * create has run. */
export type ItemRef = { id: string } | { newCode: string };

export type ProductWrite = Omit<ParsedProduct, "row" | "id">;
export type OptionWrite = Omit<ParsedOption, "row" | "id" | "compatSeries" | "compatProducts">;

export type ApplyOp =
  | { op: "detachDraftReferences"; itemType: ItemType; id: string; code: string }
  | { op: "deleteOption"; id: string; code: string }
  | { op: "deleteProduct"; id: string; code: string }
  | { op: "releaseCode"; itemType: ItemType; id: string }
  | { op: "createProduct"; code: string; data: ProductWrite }
  | { op: "updateProduct"; id: string; data: ProductWrite }
  | { op: "createOption"; code: string; data: OptionWrite }
  | { op: "updateOption"; id: string; data: OptionWrite }
  | { op: "replaceOptionCompat"; option: ItemRef; compatSeries: string[]; compatProducts: string[] }
  | { op: "upsertPrice"; itemType: ItemType; item: ItemRef; region: string; amount: number; needsReview: boolean }
  | { op: "deletePrice"; itemType: ItemType; item: ItemRef; region: string };

export type ApplyPlan = ApplyOp[];

function productWrite(p: ParsedProduct): ProductWrite {
  return {
    code: p.code,
    series: p.series,
    name: p.name,
    description: p.description,
    kind: p.kind,
    form: p.form,
    specs: p.specs,
    isCredit: p.isCredit,
    noCommission: p.noCommission,
    active: p.active,
    sortOrder: p.sortOrder,
    imageUrl: p.imageUrl,
  };
}

function optionWrite(o: ParsedOption): OptionWrite {
  return {
    code: o.code,
    name: o.name,
    shortDescription: o.shortDescription,
    role: o.role,
    parentProduct: o.parentProduct,
    unitLengthM: o.unitLengthM,
    noCommission: o.noCommission,
    active: o.active,
    sortOrder: o.sortOrder,
    imageUrl: o.imageUrl,
    attributeSchema: o.attributeSchema,
  };
}

function refFor(itemId: string | null, code: string): ItemRef {
  return itemId !== null ? { id: itemId } : { newCode: code };
}

export function buildApplyPlan(diff: CatalogDiff, parsed: ParsedCatalog): ApplyPlan {
  const plan: ApplyPlan = [];

  // 1. Deletions, options before products (an option's parentProduct points
  //    at a product; going in this order means the nulling FK never fires
  //    for a row that is itself about to be deleted).
  for (const d of diff.options.deleted) plan.push({ op: "detachDraftReferences", itemType: "option", id: d.id, code: d.code });
  for (const d of diff.products.deleted) plan.push({ op: "detachDraftReferences", itemType: "product", id: d.id, code: d.code });
  for (const d of diff.options.deleted) plan.push({ op: "deleteOption", id: d.id, code: d.code });
  for (const d of diff.products.deleted) plan.push({ op: "deleteProduct", id: d.id, code: d.code });

  // 2. Park the codes of renamed rows.
  for (const u of diff.products.updated) {
    if (u.changes.some((c) => c.field === "code")) plan.push({ op: "releaseCode", itemType: "product", id: u.id });
  }
  for (const u of diff.options.updated) {
    if (u.changes.some((c) => c.field === "code")) plan.push({ op: "releaseCode", itemType: "option", id: u.id });
  }

  // 3. Products, then options.
  const updatedProductIds = new Set(diff.products.updated.map((u) => u.id));
  for (const p of parsed.products) {
    if (p.id === null) plan.push({ op: "createProduct", code: p.code, data: productWrite(p) });
    else if (updatedProductIds.has(p.id)) plan.push({ op: "updateProduct", id: p.id, data: productWrite(p) });
  }
  const updatedOptions = new Map(diff.options.updated.map((u) => [u.id, u]));
  const compatOps: ApplyOp[] = [];
  for (const o of parsed.options) {
    if (o.id === null) {
      plan.push({ op: "createOption", code: o.code, data: optionWrite(o) });
      compatOps.push({ op: "replaceOptionCompat", option: { newCode: o.code }, compatSeries: o.compatSeries, compatProducts: o.compatProducts });
      continue;
    }
    const u = updatedOptions.get(o.id);
    if (!u) continue;
    plan.push({ op: "updateOption", id: o.id, data: optionWrite(o) });
    if (u.changes.some((c) => c.field === "compatSeries" || c.field === "compatProducts")) {
      compatOps.push({ op: "replaceOptionCompat", option: { id: o.id }, compatSeries: o.compatSeries, compatProducts: o.compatProducts });
    }
  }

  // 4. Compatibility.
  plan.push(...compatOps);

  // 5. Prices. The diff's created/updated entries name the price by item
  //    code; the parsed rows carry the resolved id, so join back on row.
  const parsedByRow = new Map(parsed.prices.map((p) => [p.row, p]));
  for (const c of [...diff.prices.created, ...diff.prices.updated]) {
    const p = parsedByRow.get(c.row);
    if (!p) continue;
    plan.push({
      op: "upsertPrice",
      itemType: p.itemType,
      item: refFor(p.itemId, p.itemCode),
      region: p.region,
      amount: p.amount,
      needsReview: p.needsReview,
    });
  }
  const idByCode = {
    product: new Map(parsed.products.filter((p) => p.id !== null).map((p) => [p.code, p.id as string])),
    option: new Map(parsed.options.filter((o) => o.id !== null).map((o) => [o.code, o.id as string])),
  };
  for (const d of diff.prices.deleted) {
    // A deleted price belongs to an item that survives (prices of deleted
    // items are not listed -- see diffPrices), so it has an id in the file.
    const id = idByCode[d.itemType].get(d.itemCode);
    if (id === undefined) continue;
    plan.push({ op: "deletePrice", itemType: d.itemType, item: { id }, region: d.region });
  }

  return plan;
}
