/**
 * Pure planner for scripts/migrate-catalog-v2.ts: target file + a snapshot
 * of the live catalogue -> the list of operations that turns the snapshot
 * into the target. No IO and no Prisma client here on purpose, so it can be
 * unit tested against RAW/catalog-dump.json (tests/catalog-v2-plan.test.ts)
 * -- the migration script is the IO shell that reads the snapshot out of
 * the database and applies the operations inside one transaction.
 *
 * Matching rule, per target row: by `id` first; when the id is null (an
 * add) or no longer exists, by any code -- the row's current `code`, a
 * `legacyCodes` entry, or the target row's own `legacyCodes` (the code the
 * row had before a rename). A keep/rename that matches nothing is an error,
 * never a silent add. An add that does match (second run) becomes an
 * update, which is what makes the plan idempotent: planning the target
 * against a snapshot that already reflects it yields no operations.
 */

import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";

// --- Target file (docs/reference/catalog-v2-target.json) --------------------

export type TargetAction = "keep" | "rename" | "add" | "delete";

export interface TargetPrices {
  AU?: number;
  US?: number;
}

export interface TargetProduct {
  id: string | null;
  action: TargetAction;
  code: string;
  legacyCodes: string[];
  series: string;
  name: string;
  description: string;
  prices: TargetPrices;
  noCommission: boolean;
  isCredit: boolean;
  kind?: ProductKind;
  form?: ProductionForm | null;
  specs?: Record<string, unknown> | null;
  /** Key of the quotation content block (prisma/seed-data/content-blocks.json)
   *  that describes the row; null/absent = none. */
  contentBlockKey?: string | null;
  needsReviewAU?: boolean;
  note?: string;
  reason?: string;
}

export interface TargetOption {
  id: string | null;
  action: TargetAction;
  code: string;
  legacyCodes: string[];
  name: string;
  description: string;
  prices: TargetPrices;
  noCommission: boolean;
  role?: OptionRole | null;
  parentProductCode?: string | null;
  unitLengthM?: number | null;
  contentBlockKey?: string | null;
  compatSeries: string[];
  compatProducts: string[];
  needsReviewAU?: boolean;
  note?: string;
  reason?: string;
}

export interface CatalogTarget {
  generatedAt: string;
  source: string;
  products: TargetProduct[];
  options: TargetOption[];
}

// --- Snapshot of the live catalogue -----------------------------------------

/** One region's price as the dump writes it (`amount` is a decimal string
 *  there; the migration script's own snapshot passes a number). */
export interface SnapshotPrice {
  amount: string | number;
  needsReview: boolean;
}

/**
 * The shape scripts/dump-catalog.ts writes, plus the identity columns an
 * old dump (RAW/catalog-dump.json) predates -- optional so it still plans.
 * A missing `kind`/`form`/`role`/`parentProductCode`/`unitLengthM` is
 * treated as "unknown" and written; a missing `contentBlockKey` is treated
 * as null (the column is nullable and most rows have no block, so only the
 * rows the target gives a key to are planned). Product `series` and option
 * `compatSeries`/`compatProducts`/`parentProductCode` are codes -- the
 * migration script resolves them to ids when it applies the plan.
 */
export interface SnapshotProduct {
  id: string;
  code: string;
  legacyCodes?: string[];
  series: string;
  name: string;
  description: string | null;
  specs: unknown;
  isCredit: boolean;
  noCommission: boolean;
  kind?: ProductKind;
  form?: ProductionForm | null;
  contentBlockKey?: string | null;
  prices: Record<string, SnapshotPrice>;
}

export interface SnapshotOption {
  id: string;
  code: string;
  legacyCodes?: string[];
  name: string;
  shortDescription: string | null;
  noCommission: boolean;
  role?: OptionRole | null;
  parentProductCode?: string | null;
  unitLengthM?: number | null;
  contentBlockKey?: string | null;
  compatSeries: string[];
  compatProducts: string[];
  prices: Record<string, SnapshotPrice>;
}

export interface CatalogSnapshot {
  series: { code: string }[];
  products: SnapshotProduct[];
  options: SnapshotOption[];
}

// --- Operations ------------------------------------------------------------

export interface ProductFields {
  code: string;
  legacyCodes: string[];
  seriesCode: string;
  name: string;
  description: string | null;
  kind: ProductKind;
  form: ProductionForm | null;
  specs: Record<string, unknown> | null;
  contentBlockKey: string | null;
  isCredit: boolean;
  noCommission: boolean;
}

export interface OptionFields {
  code: string;
  legacyCodes: string[];
  name: string;
  shortDescription: string | null;
  role: OptionRole | null;
  /** New product code (resolved to parentProductId by the script). */
  parentProductCode: string | null;
  unitLengthM: number | null;
  contentBlockKey: string | null;
  noCommission: boolean;
}

export interface FieldChange<T> {
  from: T | undefined;
  to: T;
}

export type ProductChanges = { [K in keyof ProductFields]?: FieldChange<ProductFields[K]> };
export type OptionChanges = { [K in keyof OptionFields]?: FieldChange<OptionFields[K]> };

export interface PriceSet {
  regionCode: string;
  amount: number;
  needsReview: boolean;
  from: { amount: number; needsReview: boolean } | null;
}

export type Operation =
  | { op: "product.update"; id: string; code: string; rename: boolean; changes: ProductChanges }
  | { op: "product.create"; code: string; data: ProductFields }
  | { op: "product.delete"; id: string; code: string; reason: string }
  | { op: "option.update"; id: string; code: string; rename: boolean; changes: OptionChanges }
  | { op: "option.create"; code: string; data: OptionFields }
  | { op: "option.delete"; id: string; code: string; reason: string }
  | { op: "price.set"; target: "product" | "option"; code: string; price: PriceSet }
  | {
      op: "compat.replace";
      optionCode: string;
      series: string[];
      products: string[];
      from: { series: string[]; products: string[] };
    };

export interface PlanSummary {
  products: { updated: number; renamed: number; created: number; deleted: number };
  options: { updated: number; renamed: number; created: number; deleted: number };
  prices: number;
  compat: number;
}

export interface Plan {
  operations: Operation[];
  summary: PlanSummary;
}

export class PlanError extends Error {
  constructor(
    message: string,
    public readonly problems: string[] = []
  ) {
    super(problems.length ? `${message}\n  - ${problems.join("\n  - ")}` : message);
    this.name = "PlanError";
  }
}

// --- Helpers ---------------------------------------------------------------

function sameSet(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/** Key-order-independent JSON for specs comparison. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, normalise((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

function priceOf(row: { prices: Record<string, SnapshotPrice> }, region: string) {
  const p = row.prices[region];
  if (!p) return null;
  return { amount: Number(p.amount), needsReview: p.needsReview };
}

/** Every target row that is not a delete -- the catalogue as it will be. */
function surviving<T extends { action: TargetAction }>(rows: T[]): T[] {
  return rows.filter((r) => r.action !== "delete");
}

/**
 * What a target price means for the DB: 0 = "no price yet", flagged for
 * review -- unless the row says `needsReviewAU: false` for its AU figure,
 * which marks a genuine, intentional 0 (a container product, a table
 * assembled from its options). Same rule scripts/lib/catalog-v2-seed-data.ts
 * applies when it writes catalog.json.
 */
export function pricePayload(
  amount: number,
  region: "AU" | "US",
  row: { needsReviewAU?: boolean }
): { amount: number; needsReview: boolean } {
  const genuineZero = region === "AU" && row.needsReviewAU === false;
  return { amount, needsReview: amount === 0 && !genuineZero };
}

function mergeLegacyCodes(existing: readonly string[] | undefined, target: readonly string[], oldCode: string | null, newCode: string) {
  const out: string[] = [];
  for (const c of [...(existing ?? []), ...target, ...(oldCode && oldCode !== newCode ? [oldCode] : [])]) {
    if (c !== newCode && !out.includes(c)) out.push(c);
  }
  return out;
}

// --- Validation ------------------------------------------------------------

/**
 * Internal consistency of the target file, independent of any snapshot.
 * Returns the problems rather than throwing so the test can list them.
 */
export function validateTarget(target: CatalogTarget): string[] {
  const problems: string[] = [];
  const products = surviving(target.products);
  const options = surviving(target.options);

  const dupes = (codes: string[]) => codes.filter((c, i) => codes.indexOf(c) !== i);
  for (const c of new Set(dupes(products.map((p) => p.code)))) problems.push(`duplicate product code ${c}`);
  for (const c of new Set(dupes(options.map((o) => o.code)))) problems.push(`duplicate option code ${c}`);

  const productCodes = new Set(products.map((p) => p.code));
  for (const o of options) {
    if (o.parentProductCode && !productCodes.has(o.parentProductCode)) {
      problems.push(`option ${o.code}: parentProductCode ${o.parentProductCode} is not a surviving product`);
    }
    for (const c of o.compatProducts) {
      if (!productCodes.has(c)) problems.push(`option ${o.code}: compatProducts ${c} is not a surviving product`);
    }
  }
  for (const row of [...target.products, ...target.options]) {
    if (row.action === "rename" && row.legacyCodes.length === 0) {
      problems.push(`${row.code}: rename without a legacy code`);
    }
    if (row.action === "add" && row.id !== null) problems.push(`${row.code}: add with a non-null id`);
    if (row.action !== "add" && row.id === null) problems.push(`${row.code}: ${row.action} with a null id`);
  }
  return problems;
}

// --- Matching --------------------------------------------------------------

type Matchable = { id: string; code: string; legacyCodes?: string[] };

function findMatch<T extends Matchable>(
  rows: T[],
  target: { id: string | null; code: string; legacyCodes: string[] },
  claimed: Set<string>
): T | undefined {
  const byId = target.id ? rows.find((r) => r.id === target.id) : undefined;
  if (byId && !claimed.has(byId.id)) return byId;
  const codes = [target.code, ...target.legacyCodes];
  return rows.find(
    (r) => !claimed.has(r.id) && (codes.includes(r.code) || (r.legacyCodes ?? []).some((c) => codes.includes(c)))
  );
}

// --- Planning --------------------------------------------------------------

export function planCatalogV2(target: CatalogTarget, snapshot: CatalogSnapshot): Plan {
  const problems = validateTarget(target);
  if (problems.length) throw new PlanError("catalog-v2-target.json is not consistent", problems);

  const seriesCodes = new Set(snapshot.series.map((s) => s.code));
  const operations: Operation[] = [];
  const summary: PlanSummary = {
    products: { updated: 0, renamed: 0, created: 0, deleted: 0 },
    options: { updated: 0, renamed: 0, created: 0, deleted: 0 },
    prices: 0,
    compat: 0,
  };
  const errors: string[] = [];

  // (a) products keep/rename/add
  const claimedProducts = new Set<string>();
  const productDeletes: TargetProduct[] = [];
  for (const t of target.products) {
    if (t.action === "delete") {
      productDeletes.push(t);
      continue;
    }
    if (!seriesCodes.has(t.series)) errors.push(`product ${t.code}: series ${t.series} does not exist`);
    const existing = findMatch(snapshot.products, t, claimedProducts);
    const fields: ProductFields = {
      code: t.code,
      legacyCodes: mergeLegacyCodes(existing?.legacyCodes, t.legacyCodes, existing?.code ?? null, t.code),
      seriesCode: t.series,
      name: t.name,
      description: t.description || null,
      kind: t.kind ?? "ACCESSORY",
      form: t.form ?? null,
      specs: t.specs && Object.keys(t.specs).length ? t.specs : null,
      contentBlockKey: t.contentBlockKey ?? null,
      isCredit: t.isCredit,
      noCommission: t.noCommission,
    };
    if (!existing) {
      if (t.action !== "add") {
        errors.push(`product ${t.code} (${t.action}, id ${t.id}): not found in the database by id or by any code`);
        continue;
      }
      operations.push({ op: "product.create", code: t.code, data: fields });
      summary.products.created++;
    } else {
      claimedProducts.add(existing.id);
      const changes: ProductChanges = {};
      const set = <K extends keyof ProductFields>(key: K, from: ProductFields[K] | undefined, changed: boolean) => {
        if (changed) changes[key] = { from, to: fields[key] } as ProductChanges[K];
      };
      set("code", existing.code, existing.code !== fields.code);
      set("legacyCodes", existing.legacyCodes, !sameSet(existing.legacyCodes, fields.legacyCodes));
      set("seriesCode", existing.series, existing.series !== fields.seriesCode);
      set("name", existing.name, existing.name !== fields.name);
      set("description", existing.description, (existing.description ?? null) !== fields.description);
      set("kind", existing.kind, existing.kind !== fields.kind);
      set("form", existing.form, existing.form === undefined || (existing.form ?? null) !== fields.form);
      set("specs", existing.specs as ProductFields["specs"], !sameJson(existing.specs ?? null, fields.specs));
      set("contentBlockKey", existing.contentBlockKey, (existing.contentBlockKey ?? null) !== fields.contentBlockKey);
      set("isCredit", existing.isCredit, existing.isCredit !== fields.isCredit);
      set("noCommission", existing.noCommission, existing.noCommission !== fields.noCommission);
      if (Object.keys(changes).length) {
        const rename = changes.code !== undefined;
        operations.push({ op: "product.update", id: existing.id, code: t.code, rename, changes });
        summary.products.updated++;
        if (rename) summary.products.renamed++;
      }
    }
    for (const region of ["AU", "US"] as const) {
      const amount = t.prices[region];
      if (amount === undefined) continue;
      const to = pricePayload(amount, region, t);
      const from = existing ? priceOf(existing, region) : null;
      if (from && from.amount === to.amount && from.needsReview === to.needsReview) continue;
      operations.push({ op: "price.set", target: "product", code: t.code, price: { regionCode: region, ...to, from } });
      summary.prices++;
    }
  }

  // (b) options keep/rename/add
  const survivingProductCodes = new Set(surviving(target.products).map((p) => p.code));
  const claimedOptions = new Set<string>();
  const optionDeletes: TargetOption[] = [];
  for (const t of target.options) {
    if (t.action === "delete") {
      optionDeletes.push(t);
      continue;
    }
    for (const s of t.compatSeries) if (!seriesCodes.has(s)) errors.push(`option ${t.code}: series ${s} does not exist`);
    for (const p of t.compatProducts) {
      if (!survivingProductCodes.has(p)) errors.push(`option ${t.code}: compat product ${p} does not survive`);
    }
    const existing = findMatch(snapshot.options, t, claimedOptions);
    const fields: OptionFields = {
      code: t.code,
      legacyCodes: mergeLegacyCodes(existing?.legacyCodes, t.legacyCodes, existing?.code ?? null, t.code),
      name: t.name,
      shortDescription: t.description || null,
      role: t.role ?? null,
      parentProductCode: t.parentProductCode ?? null,
      unitLengthM: t.unitLengthM ?? null,
      contentBlockKey: t.contentBlockKey ?? null,
      noCommission: t.noCommission,
    };
    if (!existing) {
      if (t.action !== "add") {
        errors.push(`option ${t.code} (${t.action}, id ${t.id}): not found in the database by id or by any code`);
        continue;
      }
      operations.push({ op: "option.create", code: t.code, data: fields });
      summary.options.created++;
    } else {
      claimedOptions.add(existing.id);
      const changes: OptionChanges = {};
      const set = <K extends keyof OptionFields>(key: K, from: OptionFields[K] | undefined, changed: boolean) => {
        if (changed) changes[key] = { from, to: fields[key] } as OptionChanges[K];
      };
      set("code", existing.code, existing.code !== fields.code);
      set("legacyCodes", existing.legacyCodes, !sameSet(existing.legacyCodes, fields.legacyCodes));
      set("name", existing.name, existing.name !== fields.name);
      set(
        "shortDescription",
        existing.shortDescription,
        (existing.shortDescription ?? null) !== fields.shortDescription
      );
      set("role", existing.role, existing.role === undefined || (existing.role ?? null) !== fields.role);
      set(
        "parentProductCode",
        existing.parentProductCode,
        existing.parentProductCode === undefined || (existing.parentProductCode ?? null) !== fields.parentProductCode
      );
      set(
        "unitLengthM",
        existing.unitLengthM,
        existing.unitLengthM === undefined || Number(existing.unitLengthM ?? null) !== Number(fields.unitLengthM)
      );
      set("contentBlockKey", existing.contentBlockKey, (existing.contentBlockKey ?? null) !== fields.contentBlockKey);
      set("noCommission", existing.noCommission, existing.noCommission !== fields.noCommission);
      if (Object.keys(changes).length) {
        const rename = changes.code !== undefined;
        operations.push({ op: "option.update", id: existing.id, code: t.code, rename, changes });
        summary.options.updated++;
        if (rename) summary.options.renamed++;
      }
    }
    // Compatibility: the product side is compared by *new* product code --
    // a snapshot taken before the products are renamed still lists the old
    // codes, so they are translated through the target's rename map first.
    const from = existing
      ? { series: existing.compatSeries, products: existing.compatProducts.map((c) => newProductCode(target, c)) }
      : { series: [], products: [] };
    if (!existing || !sameSet(from.series, t.compatSeries) || !sameSet(from.products, t.compatProducts)) {
      operations.push({
        op: "compat.replace",
        optionCode: t.code,
        series: [...t.compatSeries],
        products: [...t.compatProducts],
        from: existing ? { series: existing.compatSeries, products: existing.compatProducts } : from,
      });
      summary.compat++;
    }
    for (const region of ["AU", "US"] as const) {
      const amount = t.prices[region];
      if (amount === undefined) continue;
      const to = pricePayload(amount, region, t);
      const fromPrice = existing ? priceOf(existing, region) : null;
      if (fromPrice && fromPrice.amount === to.amount && fromPrice.needsReview === to.needsReview) continue;
      operations.push({
        op: "price.set",
        target: "option",
        code: t.code,
        price: { regionCode: region, ...to, from: fromPrice },
      });
      summary.prices++;
    }
  }

  // (c) deletes -- options first, then products. A delete row names the
  // row by id or by its current code; a row already claimed by a
  // keep/rename/add above is never deleted (the file would be inconsistent).
  for (const t of optionDeletes) {
    const existing = findMatch(snapshot.options, t, claimedOptions);
    if (!existing) continue; // already gone
    claimedOptions.add(existing.id);
    operations.push({ op: "option.delete", id: existing.id, code: existing.code, reason: t.reason ?? "" });
    summary.options.deleted++;
  }
  for (const t of productDeletes) {
    const existing = findMatch(snapshot.products, t, claimedProducts);
    if (!existing) continue;
    claimedProducts.add(existing.id);
    operations.push({ op: "product.delete", id: existing.id, code: existing.code, reason: t.reason ?? "" });
    summary.products.deleted++;
  }

  // Resulting codes must be unique across products and across options,
  // counting the rows the file does not mention (hand-created ones stay).
  const finalProductCodes = [
    ...surviving(target.products).map((p) => p.code),
    ...snapshot.products.filter((p) => !claimedProducts.has(p.id)).map((p) => p.code),
  ];
  const finalOptionCodes = [
    ...surviving(target.options).map((o) => o.code),
    ...snapshot.options.filter((o) => !claimedOptions.has(o.id)).map((o) => o.code),
  ];
  for (const c of finalProductCodes.filter((c, i) => finalProductCodes.indexOf(c) !== i)) {
    errors.push(`product code ${c} would not be unique after migration`);
  }
  for (const c of finalOptionCodes.filter((c, i) => finalOptionCodes.indexOf(c) !== i)) {
    errors.push(`option code ${c} would not be unique after migration`);
  }
  // A rename onto a code still held by a row this plan deletes would hit
  // the unique index before the delete runs (deletes go last).
  const deletedProductCodes = new Set(operations.flatMap((o) => (o.op === "product.delete" ? [o.code] : [])));
  const deletedOptionCodes = new Set(operations.flatMap((o) => (o.op === "option.delete" ? [o.code] : [])));
  for (const o of operations) {
    if ((o.op === "product.update" && o.rename) || o.op === "product.create") {
      if (deletedProductCodes.has(o.code)) errors.push(`product code ${o.code} is taken by a row this plan deletes`);
    }
    if ((o.op === "option.update" && o.rename) || o.op === "option.create") {
      if (deletedOptionCodes.has(o.code)) errors.push(`option code ${o.code} is taken by a row this plan deletes`);
    }
  }

  if (errors.length) throw new PlanError("cannot plan the catalogue v2 migration", errors);
  return { operations, summary };
}

/** The code a product will have after the migration, given any code it has now. */
export function newProductCode(target: CatalogTarget, currentCode: string): string {
  for (const p of surviving(target.products)) {
    if (p.code === currentCode || p.legacyCodes.includes(currentCode)) return p.code;
  }
  return currentCode;
}

// --- Rendering (for --dry-run) ---------------------------------------------

function fmt(value: unknown): string {
  if (value === undefined) return "?";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(fmt).join(", ")}]`;
  return JSON.stringify(value);
}

export function renderOperation(o: Operation): string {
  switch (o.op) {
    case "product.update":
    case "option.update": {
      const label = o.op === "product.update" ? "product" : "option";
      const head = o.rename
        ? `${label} rename ${fmt(o.changes.code?.from)} -> ${fmt(o.code)}`
        : `${label} update ${fmt(o.code)}`;
      const details = Object.entries(o.changes)
        .filter(([k]) => k !== "code")
        .map(([k, v]) => `      ${k}: ${fmt(v?.from)} -> ${fmt(v?.to)}`);
      return [head, ...details].join("\n");
    }
    case "product.create": {
      const block = o.data.contentBlockKey ? ` block ${fmt(o.data.contentBlockKey)}` : "";
      return `product add ${fmt(o.code)} (${o.data.seriesCode}, ${o.data.kind}) ${fmt(o.data.name)}${block}`;
    }
    case "option.create": {
      const block = o.data.contentBlockKey ? ` block ${fmt(o.data.contentBlockKey)}` : "";
      return `option add ${fmt(o.code)} (${o.data.role ?? "no role"}) ${fmt(o.data.name)}${block}`;
    }
    case "product.delete":
      return `product delete ${fmt(o.code)} [${o.id}] -- ${o.reason}`;
    case "option.delete":
      return `option delete ${fmt(o.code)} [${o.id}] -- ${o.reason}`;
    case "price.set": {
      const from = o.price.from ? `${o.price.from.amount}${o.price.from.needsReview ? " (review)" : ""}` : "none";
      return `price ${o.target} ${fmt(o.code)} ${o.price.regionCode}: ${from} -> ${o.price.amount}${o.price.needsReview ? " (review)" : ""}`;
    }
    case "compat.replace":
      return `compat ${fmt(o.optionCode)}: series ${fmt(o.from.series)} products ${fmt(o.from.products)} -> series ${fmt(o.series)} products ${fmt(o.products)}`;
  }
}

export function renderSummary(s: PlanSummary): string {
  return [
    `products: ${s.products.updated} updated (${s.products.renamed} renamed), ${s.products.created} added, ${s.products.deleted} deleted`,
    `options:  ${s.options.updated} updated (${s.options.renamed} renamed), ${s.options.created} added, ${s.options.deleted} deleted`,
    `prices:   ${s.prices} set`,
    `compat:   ${s.compat} options re-linked`,
  ].join("\n");
}
