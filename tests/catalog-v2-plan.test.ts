import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type CatalogSnapshot,
  type CatalogTarget,
  type Operation,
  type SnapshotOption,
  type SnapshotProduct,
  PlanError,
  planCatalogV2,
  renderOperation,
  renderSummary,
} from "../scripts/lib/catalog-v2-plan";

const ROOT = path.resolve(__dirname, "..");
const target = JSON.parse(readFileSync(path.join(ROOT, "docs/reference/catalog-v2-target.json"), "utf8")) as CatalogTarget;
/** Snapshot of the live database taken before the migration (scripts/dump-catalog.ts). */
const dumpPath = existsSync(path.join(ROOT, "tests/fixtures/catalog-dump.json"))
  ? path.join(ROOT, "tests/fixtures/catalog-dump.json")
  : path.join(ROOT, "RAW/catalog-dump.json");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as CatalogSnapshot;

/**
 * In-memory reducer mirroring what scripts/migrate-catalog-v2.ts does to the
 * database, so the planner can be checked for idempotence without one:
 * apply the plan to the snapshot, plan again, expect nothing.
 */
function applyToSnapshot(snapshot: CatalogSnapshot, operations: Operation[]): CatalogSnapshot {
  const products: SnapshotProduct[] = snapshot.products.map((p) => ({ ...p, prices: { ...p.prices } }));
  const options: SnapshotOption[] = snapshot.options.map((o) => ({ ...o, prices: { ...o.prices } }));
  const renamedProducts = new Map<string, string>();
  let nextId = 1;
  for (const op of operations) {
    switch (op.op) {
      case "product.update": {
        const row = products.find((p) => p.id === op.id)!;
        if (op.changes.code) renamedProducts.set(op.changes.code.from!, op.changes.code.to);
        for (const [key, change] of Object.entries(op.changes)) {
          const k = key === "seriesCode" ? "series" : key;
          (row as unknown as Record<string, unknown>)[k] = change!.to;
        }
        break;
      }
      case "product.create":
        products.push({
          id: `new-${nextId++}`,
          code: op.data.code,
          series: op.data.seriesCode,
          name: op.data.name,
          description: op.data.description,
          specs: op.data.specs,
          isCredit: op.data.isCredit,
          noCommission: op.data.noCommission,
          kind: op.data.kind,
          form: op.data.form,
          contentBlockKey: op.data.contentBlockKey,
          prices: {},
        });
        break;
      case "product.delete":
        products.splice(products.findIndex((p) => p.id === op.id), 1);
        break;
      case "option.update": {
        const row = options.find((o) => o.id === op.id)!;
        for (const [key, change] of Object.entries(op.changes)) {
          (row as unknown as Record<string, unknown>)[key] = change!.to;
        }
        break;
      }
      case "option.create":
        options.push({
          id: `new-${nextId++}`,
          code: op.data.code,
          name: op.data.name,
          shortDescription: op.data.shortDescription,
          noCommission: op.data.noCommission,
          role: op.data.role,
          parentProductCode: op.data.parentProductCode,
          unitLengthM: op.data.unitLengthM,
          contentBlockKey: op.data.contentBlockKey,
          compatSeries: [],
          compatProducts: [],
          prices: {},
        });
        break;
      case "option.delete":
        options.splice(options.findIndex((o) => o.id === op.id), 1);
        break;
      case "price.set": {
        const row = op.target === "product" ? products.find((p) => p.code === op.code)! : options.find((o) => o.code === op.code)!;
        row.prices[op.price.regionCode] = { amount: op.price.amount, needsReview: op.price.needsReview };
        break;
      }
      case "compat.replace": {
        const row = options.find((o) => o.code === op.optionCode)!;
        row.compatSeries = [...op.series];
        row.compatProducts = [...op.products];
        break;
      }
    }
  }
  // A product rename is visible through the compat rows that point at it.
  for (const o of options) o.compatProducts = o.compatProducts.map((c) => renamedProducts.get(c) ?? c);
  return { series: snapshot.series, products, options };
}

describe("planCatalogV2 against the pre-migration dump", () => {
  const plan = planCatalogV2(target, dump);
  const ops = plan.operations;

  it("plans the renames, deletes and adds the decisions file describes", () => {
    expect(plan.summary.products).toMatchObject({ renamed: 19, deleted: 12, created: 1 });
    expect(plan.summary.options).toMatchObject({ renamed: 45, deleted: 23, created: 8 });
  });

  it("renames M3180 -> M-3180, matched by id", () => {
    const op = ops.find((o) => o.op === "product.update" && o.code === "M-3180");
    expect(op).toBeDefined();
    if (op?.op !== "product.update") throw new Error("unreachable");
    expect(op.rename).toBe(true);
    expect(op.changes.code).toEqual({ from: "M3180", to: "M-3180" });
    expect(op.changes.kind?.to).toBe("MACHINE");
    expect(op.changes.form?.to).toBe("M_SERIES");
  });

  it("adds L-320EF with the US price that moves off L-320F, and zeroes L-320F's US price", () => {
    expect(ops).toContainEqual(expect.objectContaining({ op: "product.create", code: "L-320EF" }));
    expect(ops).toContainEqual({
      op: "price.set",
      target: "product",
      code: "L-320EF",
      price: { regionCode: "US", amount: 154864, needsReview: false, from: null },
    });
    expect(ops).toContainEqual({
      op: "price.set",
      target: "product",
      code: "L-320F",
      price: { regionCode: "US", amount: 0, needsReview: true, from: { amount: 154864, needsReview: false } },
    });
  });

  it("re-parents every EasyLoader module option by role and unit length", () => {
    const dm12 = ops.find((o) => o.op === "option.update" && o.code === "EL-2020-DM12");
    if (dm12?.op !== "option.update") throw new Error("expected EL-2020-DM12 update");
    expect(dm12.changes.code?.from).toBe("EL-2020 Additional 1.2M lengths");
    expect(dm12.changes.role?.to).toBe("EL_CONVEYOR");
    expect(dm12.changes.parentProductCode?.to).toBe("EL-2020");
    expect(dm12.changes.unitLengthM?.to).toBe(1.2);
  });

  it("carries the content-block key: written where the target names one, untouched where the snapshot already has it", () => {
    // The dump predates the column, so a missing key reads as null and only
    // the rows the target links to a block get an update...
    const m3180 = ops.find((o) => o.op === "product.update" && o.code === "M-3180");
    if (m3180?.op !== "product.update") throw new Error("expected M-3180 update");
    expect(m3180.changes.contentBlockKey).toEqual({ from: undefined, to: "machine.m-series" });
    const mts = ops.find((o) => o.op === "option.update" && o.code === "MTS");
    if (mts?.op !== "option.update") throw new Error("expected MTS update");
    expect(mts.changes.contentBlockKey).toEqual({ from: undefined, to: "option.MTS" });
    const noBlock = ops.filter((o) => o.op === "option.update" && o.code === "TR220");
    for (const o of noBlock) if (o.op === "option.update") expect(o.changes.contentBlockKey).toBeUndefined();
    // ...whereas a snapshot that already carries the key plans nothing for it.
    const keyed: CatalogSnapshot = {
      ...dump,
      products: dump.products.map((p) => (p.code === "M3180" ? { ...p, contentBlockKey: "machine.m-series" } : p)),
    };
    const again = planCatalogV2(target, keyed).operations.find((o) => o.op === "product.update" && o.code === "M-3180");
    if (again?.op !== "product.update") throw new Error("expected M-3180 update");
    expect(again.changes.contentBlockKey).toBeUndefined();
  });

  it("removes X from the options the US X sheet does not list", () => {
    const abr = ops.find((o) => o.op === "compat.replace" && o.optionCode === "ABR-M");
    expect(abr).toEqual({ op: "compat.replace", optionCode: "ABR-M", series: ["M"], products: [], from: { series: ["M", "X"], products: [] } });
  });

  it("deletes the software options and the X-Calibre widths, options before products", () => {
    const deletedOptions = ops.filter((o) => o.op === "option.delete").map((o) => o.code);
    expect(deletedOptions).toEqual(expect.arrayContaining(["PTW", "PRA-L", "JetPen", "Crate-M", "320-E"]));
    const deletedProducts = ops.filter((o) => o.op === "product.delete").map((o) => o.code);
    expect(deletedProducts).toEqual(expect.arrayContaining(["X-3180", "X-10390", "PTN", "EDG"]));
    const lastOptionDelete = ops.map((o) => o.op).lastIndexOf("option.delete");
    const firstProductDelete = ops.map((o) => o.op).indexOf("product.delete");
    expect(lastOptionDelete).toBeLessThan(firstProductDelete);
    // Nothing before the deletes touches a deleted row's id.
    const deletedIds = new Set(ops.flatMap((o) => (o.op.endsWith(".delete") && "id" in o ? [o.id] : [])));
    for (const o of ops) if ("id" in o && !o.op.endsWith(".delete")) expect(deletedIds.has(o.id)).toBe(false);
  });

  it("lists every delete after every other operation (the script applies by op type in that order)", () => {
    const firstDelete = ops.findIndex((o) => o.op.endsWith(".delete"));
    expect(firstDelete).toBeGreaterThan(0);
    expect(ops.slice(firstDelete).every((o) => o.op.endsWith(".delete"))).toBe(true);
  });

  it("is idempotent: applying the plan and planning again yields no operations", () => {
    const after = applyToSnapshot(dump, ops);
    const second = planCatalogV2(target, after);
    expect(second.operations.map(renderOperation)).toEqual([]);
    expect(second.summary).toEqual({
      products: { updated: 0, renamed: 0, created: 0, deleted: 0 },
      options: { updated: 0, renamed: 0, created: 0, deleted: 0 },
      prices: 0,
      compat: 0,
    });
  });

  it("leaves rows the target does not mention alone", () => {
    const withExtra: CatalogSnapshot = {
      ...dump,
      products: [...dump.products, { ...dump.products[0], id: "hand-made", code: "HAND-1" }],
      options: [...dump.options, { ...dump.options[0], id: "hand-opt", code: "HAND-OPT" }],
    };
    const plan2 = planCatalogV2(target, withExtra);
    expect(plan2.operations.some((o) => "id" in o && (o.id === "hand-made" || o.id === "hand-opt"))).toBe(false);
    expect(plan2.summary).toEqual(plan.summary);
  });

  it("renders every operation and the summary as one line per row", () => {
    for (const o of ops) expect(renderOperation(o).length).toBeGreaterThan(0);
    expect(renderSummary(plan.summary)).toContain("19 renamed");
    expect(renderSummary(plan.summary)).toContain("45 renamed");
  });
});

describe("planCatalogV2 matching and errors", () => {
  it("matches by exact current code when the id is unknown (a database with different ids)", () => {
    // A migrated database whose ids differ from the target's (re-seeded
    // from scratch, say) already holds every row under its v2 code, so
    // every keep/rename/add matches by code and nothing is planned.
    const migrated = applyToSnapshot(dump, planCatalogV2(target, dump).operations);
    const reIdd: CatalogSnapshot = {
      ...migrated,
      products: migrated.products.map((p, i) => ({ ...p, id: `p${i}` })),
      options: migrated.options.map((o, i) => ({ ...o, id: `o${i}` })),
    };
    expect(planCatalogV2(target, reIdd).operations).toEqual([]);
  });

  it("refuses a rename whose id is unknown and whose new code is not in the database (no old-code history)", () => {
    // The pre-migration dump under different ids: the rows still carry the
    // old codes, and with no history of old codes anywhere the planner has
    // nothing to match a rename on -- an error, never a silent add.
    const reIdd: CatalogSnapshot = {
      ...dump,
      products: dump.products.map((p, i) => ({ ...p, id: `p${i}` })),
      options: dump.options.map((o, i) => ({ ...o, id: `o${i}` })),
    };
    expect(() => planCatalogV2(target, reIdd)).toThrow(PlanError);
    expect(() => planCatalogV2(target, reIdd)).toThrow(/M-3180 \(rename, id cmtfmusj4000reo9ka2r20or3\): not found in the database by id or by code/);
  });

  it("refuses a keep/rename that matches nothing rather than adding it", () => {
    const missing: CatalogSnapshot = { ...dump, products: dump.products.filter((p) => p.code !== "M3180") };
    expect(() => planCatalogV2(target, missing)).toThrow(PlanError);
    expect(() => planCatalogV2(target, missing)).toThrow(/M-3180 \(rename, id cmtfmusj4000reo9ka2r20or3\): not found/);
  });

  it("refuses a target whose resulting codes collide with a hand-made row", () => {
    const clash: CatalogSnapshot = {
      ...dump,
      options: [...dump.options, { ...dump.options[0], id: "clash", code: "TR480" }],
    };
    // TR480 is an add in the target; a hand-made TR480 is matched by code
    // instead (the add becomes an update), so no collision arises...
    expect(planCatalogV2(target, clash).summary.options.created).toBe(7);
    // ...whereas a second hand-made row under a code the target renames to
    // cannot be reconciled.
    const clash2: CatalogSnapshot = {
      ...dump,
      products: [...dump.products, { ...dump.products[0], id: "clash", code: "M-3180" }],
    };
    expect(() => planCatalogV2(target, clash2)).toThrow(/M-3180/);
  });

  it("validates the target before planning", () => {
    const broken: CatalogTarget = {
      ...target,
      options: [...target.options, { ...target.options[0], id: null, action: "add", code: target.options[0].code }],
    };
    expect(() => planCatalogV2(broken, dump)).toThrow(/duplicate option code/);
  });

  it("treats an AU 0 as 'no price yet' unless the row says needsReviewAU: false", () => {
    const service = (ops: Operation[]) =>
      ops.filter((o) => o.op === "price.set" && o.code === "SERVICE" && o.price.regionCode === "AU");
    // The dump has SERVICE at 0 / not flagged, and the target says
    // needsReviewAU: false (a container product, free by design) -- nothing
    // to do...
    expect(service(planCatalogV2(target, dump).operations)).toEqual([]);
    // ...whereas a plain 0 without that marker is a gap, and gets flagged.
    const gap: CatalogTarget = {
      ...target,
      products: target.products.map((p) => (p.code === "SERVICE" ? { ...p, needsReviewAU: undefined } : p)),
    };
    expect(service(planCatalogV2(gap, dump).operations)).toEqual([
      { op: "price.set", target: "product", code: "SERVICE", price: { regionCode: "AU", amount: 0, needsReview: true, from: { amount: 0, needsReview: false } } },
    ]);
  });

  it("compares option compatibility by the product's new code, through the renames it plans", () => {
    // The dump has no option scoped to a product the target renames, so
    // build one: ABR-M fitted to M3180 (the pre-rename code) with the target
    // saying M-3180 -- the same product, so no compat.replace is planned...
    const abrId = dump.options.find((o) => o.code === "ABR-M")!.id;
    const abr = target.options.find((o) => o.id === abrId)!;
    const scoped = (compatProducts: string[]): CatalogSnapshot => ({
      ...dump,
      options: dump.options.map((o) => (o.id === abrId ? { ...o, compatSeries: [...abr.compatSeries], compatProducts } : o)),
    });
    const scopedTarget: CatalogTarget = {
      ...target,
      options: target.options.map((o) => (o.id === abrId ? { ...o, compatProducts: ["M-3180"] } : o)),
    };
    const compat = (ops: Operation[]) => ops.filter((o) => o.op === "compat.replace" && o.optionCode === "ABR-M");
    expect(compat(planCatalogV2(scopedTarget, scoped(["M3180"])).operations)).toEqual([]);
    // ...whereas a different product (M3220, renamed to M-3220) is a change.
    expect(compat(planCatalogV2(scopedTarget, scoped(["M3220"])).operations)).toEqual([
      { op: "compat.replace", optionCode: "ABR-M", series: [...abr.compatSeries], products: ["M-3180"], from: { series: [...abr.compatSeries], products: ["M3220"] } },
    ]);
  });
});
