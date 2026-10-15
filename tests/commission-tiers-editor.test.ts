import { describe, it, expect } from "vitest";
import {
  flatRateRows,
  rowEndLabel,
  rowsFromTiers,
  tiersFromRows,
  type TierRowInput,
} from "../src/lib/commission-tiers-editor";
import {
  computeTotals,
  DEFAULT_COMMISSION_TIERS,
  parseCommissionTiers,
  validateCommissionTiers,
  type CommissionTier,
} from "../src/lib/pricing";

const rows = (...pairs: [string, string][]): TierRowInput[] =>
  pairs.map(([fromPct, ratePct]) => ({ fromPct, ratePct }));

function tiersOf(input: TierRowInput[]): CommissionTier[] {
  const result = tiersFromRows(input);
  if ("error" in result) throw new Error(result.error);
  return result.tiers;
}

function errorOf(input: TierRowInput[]): string {
  const result = tiersFromRows(input);
  if (!("error" in result)) throw new Error("expected an error");
  return result.error;
}

describe("tiersFromRows — the per-user commission editor", () => {
  it("turns a flat-rate row into one tier covering every discount from 0%", () => {
    const tiers = tiersOf(flatRateRows("4"));
    expect(tiers).toEqual([{ minPct: 0, maxPct: null, ratePct: 4 }]);
    expect(validateCommissionTiers(tiers)).toBeNull();
  });

  it("round-trips the owner's standard table through the rows the admin sees", () => {
    const shown = rowsFromTiers(DEFAULT_COMMISSION_TIERS);
    expect(shown.map((r) => r.fromPct)).toEqual(["0", "0.01", "5.01", "10.01", "15.01"]);
    expect(tiersOf(shown)).toEqual(DEFAULT_COMMISSION_TIERS);
  });

  it("derives each row's end from the next row's start, so any start the admin types is allowed", () => {
    const tiers = tiersOf(rows(["0", "6"], ["3", "5.5"], ["12.5", "4"]));
    expect(tiers).toEqual([
      { minPct: 0, maxPct: 2.99, ratePct: 6 },
      { minPct: 3, maxPct: 12.49, ratePct: 5.5 },
      { minPct: 12.5, maxPct: null, ratePct: 4 },
    ]);
    expect(validateCommissionTiers(tiers)).toBeNull();
  });

  it("always starts the first row at 0%, whatever its field holds", () => {
    expect(tiersOf(rows(["7", "4"]))[0].minPct).toBe(0);
  });

  it("accepts no rows at all — no commission", () => {
    expect(tiersOf([])).toEqual([]);
  });

  it("refuses a row that does not start above the one before it", () => {
    expect(errorOf(rows(["0", "5"], ["5", "4"], ["5", "3"]))).toMatch(/Row 3 must start above row 2 \(5%\)/);
    expect(errorOf(rows(["0", "5"], ["0", "4"]))).toMatch(/Row 2 must start above row 1 \(0%\)/);
  });

  it("refuses a missing or malformed start or rate, naming the row", () => {
    expect(errorOf(rows(["0", "5"], ["", "4"]))).toMatch(/^Row 2: enter where it starts/);
    expect(errorOf(rows(["0", "5"], ["1.234", "4"]))).toMatch(/^Row 2: enter where it starts/);
    expect(errorOf(rows(["0", "5"], ["101", "4"]))).toMatch(/^Row 2: enter where it starts/);
    expect(errorOf(rows(["0", ""]))).toMatch(/^Row 1: enter the commission rate/);
    expect(errorOf(rows(["0", "-1"]))).toMatch(/^Row 1: enter the commission rate/);
  });
});

describe("rowEndLabel", () => {
  const table = rows(["0", "5"], ["0.01", "4.75"], ["5.01", "4.5"]);

  it("shows each row's end as one hundredth before the next row's start", () => {
    expect(rowEndLabel(table, 0)).toBe("0%");
    expect(rowEndLabel(table, 1)).toBe("5%");
  });

  it("shows the last row as 'and above'", () => {
    expect(rowEndLabel(table, 2)).toBe("and above");
  });

  it("shows nothing while the next start is not usable yet", () => {
    expect(rowEndLabel(rows(["0", "5"], ["", "4"]), 0)).toBeNull();
    expect(rowEndLabel(rows(["0", "5"], ["0", "4"]), 0)).toBeNull();
  });
});

describe("parseCommissionTiers — reading User.commissionTiers back", () => {
  it("returns a valid stored table as it is", () => {
    expect(parseCommissionTiers(DEFAULT_COMMISSION_TIERS)).toEqual(DEFAULT_COMMISSION_TIERS);
    expect(parseCommissionTiers([{ minPct: 0, maxPct: null, ratePct: 4 }])).toEqual([
      { minPct: 0, maxPct: null, ratePct: 4 },
    ]);
  });

  it("reads anything malformed or invalid as no commission, never as a partial table", () => {
    expect(parseCommissionTiers(null)).toEqual([]);
    expect(parseCommissionTiers("[]")).toEqual([]);
    expect(parseCommissionTiers([{ minPct: 0, maxPct: null }])).toEqual([]);
    expect(parseCommissionTiers([{ minPct: "0", maxPct: null, ratePct: 4 }])).toEqual([]);
    // A gap: 5% to 10% is not covered.
    expect(
      parseCommissionTiers([
        { minPct: 0, maxPct: 5, ratePct: 5 },
        { minPct: 10, maxPct: null, ratePct: 4 },
      ])
    ).toEqual([]);
    // Does not start at 0%: a quote at full price would earn nothing.
    expect(parseCommissionTiers([{ minPct: 0.01, maxPct: null, ratePct: 4 }])).toEqual([]);
  });
});

describe("a flat-rate manager earns the same rate at any discount, full price included", () => {
  const flat = tiersOf(flatRateRows("4"));
  const input = (discountPct: string) => ({
    items: [{ unitPrice: "10000.00", qty: 1, lines: [] }],
    extraLines: [],
    documentDiscountMode: "PERCENT" as const,
    documentDiscountValue: discountPct,
    taxRate: 0,
    commissionTiers: flat,
  });

  it("pays 4% on a quote at full price", () => {
    expect(computeTotals(input("0")).commission).toEqual({ base: "10000.00", ratePct: 4, amount: "400.00" });
  });

  it("pays 4% on a discounted quote too", () => {
    expect(computeTotals(input("12")).commission).toEqual({ base: "8800.00", ratePct: 4, amount: "352.00" });
  });

  it("shows no commission for a user with no table", () => {
    expect(computeTotals({ ...input("0"), commissionTiers: [] }).commission).toBeNull();
  });
});
