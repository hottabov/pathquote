import { describe, expect, it } from "vitest";
import {
  compareSortValues,
  filterAndSortRows,
  nextSortState,
  normalizeSearchText,
  prepareRows,
  searchTerms,
  type SortState,
} from "@/lib/list-table";

/**
 * The /quotes and /clients lists filter and sort in the browser (see
 * src/components/ui-kit/list-table.tsx). These cover the rules themselves:
 * what a search term matches, what order a column sorts in, and what a
 * second click on the same header does.
 */

type Row = { number: string; company: string; total: number; updated: number };

const ROWS: Row[] = [
  { number: "Q-AU-2026-009", company: "Johns Special Boats", total: 629_930.68, updated: 300 },
  { number: "Q-AU-2026-010", company: "acme textiles", total: 1_200, updated: 100 },
  { number: "Q-AU-2026-002", company: "Zephyr Marine", total: 45_000, updated: 200 },
];

type Key = "number" | "company" | "total" | "updated";

const prepared = prepareRows<Row, Key>(
  ROWS,
  (row) => ({
    number: row.number,
    company: row.company,
    total: row.total,
    updated: row.updated,
  }),
  (row) => `${row.number} ${row.company} ${row.total}`
);

function order(query: string, sort: SortState<Key>): string[] {
  return filterAndSortRows(prepared, query, sort).map((row) => row.number);
}

describe("normalizeSearchText", () => {
  it("lowercases and collapses whitespace on both sides of a match", () => {
    expect(normalizeSearchText("  Johns   Special  BOATS ")).toBe("johns special boats");
  });

  it("splits a query into terms, dropping the empty ones", () => {
    expect(searchTerms("  acme   draft ")).toEqual(["acme", "draft"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("compareSortValues", () => {
  it("compares numbers numerically, not as text", () => {
    // "1200" < "45000" as text too, but "9" > "45000" is where text loses.
    expect(compareSortValues(9, 45_000)).toBeLessThan(0);
  });

  it("orders numbered strings by their number, not digit by digit", () => {
    expect(compareSortValues("Q-AU-2026-009", "Q-AU-2026-010")).toBeLessThan(0);
  });

  it("ignores case, so a lowercase company doesn't sort after every other one", () => {
    expect(compareSortValues("acme textiles", "Johns Special Boats")).toBeLessThan(0);
  });
});

describe("filterAndSortRows", () => {
  it("sorts by a text column ascending and descending", () => {
    expect(order("", { key: "company", direction: "asc" })).toEqual([
      "Q-AU-2026-010",
      "Q-AU-2026-009",
      "Q-AU-2026-002",
    ]);
    expect(order("", { key: "company", direction: "desc" })).toEqual([
      "Q-AU-2026-002",
      "Q-AU-2026-009",
      "Q-AU-2026-010",
    ]);
  });

  it("sorts a money column by value", () => {
    expect(order("", { key: "total", direction: "desc" })).toEqual([
      "Q-AU-2026-009",
      "Q-AU-2026-002",
      "Q-AU-2026-010",
    ]);
  });

  it("sorts a date column by timestamp, newest first", () => {
    expect(order("", { key: "updated", direction: "desc" })).toEqual([
      "Q-AU-2026-009",
      "Q-AU-2026-002",
      "Q-AU-2026-010",
    ]);
  });

  it("matches a prefix of any searched field, case-insensitively", () => {
    expect(order("joh", { key: "number", direction: "asc" })).toEqual(["Q-AU-2026-009"]);
    expect(order("ACME", { key: "number", direction: "asc" })).toEqual(["Q-AU-2026-010"]);
    expect(order("-002", { key: "number", direction: "asc" })).toEqual(["Q-AU-2026-002"]);
  });

  it("requires every term to match, so two words narrow rather than widen", () => {
    expect(order("acme 1200", { key: "number", direction: "asc" })).toEqual(["Q-AU-2026-010"]);
    expect(order("acme zephyr", { key: "number", direction: "asc" })).toEqual([]);
  });

  it("returns every row for a blank or whitespace-only query", () => {
    expect(order("   ", { key: "number", direction: "asc" })).toHaveLength(3);
  });

  it("keeps ties in the order the server sent them", () => {
    const tied = prepareRows<Row, "company">(
      ROWS,
      () => ({ company: "same" }),
      (row) => row.number
    );
    expect(filterAndSortRows(tied, "", { key: "company", direction: "asc" }).map((r) => r.number)).toEqual(
      ROWS.map((r) => r.number)
    );
    // Reversing the direction must not reverse rows that never differed.
    expect(
      filterAndSortRows(tied, "", { key: "company", direction: "desc" }).map((r) => r.number)
    ).toEqual(ROWS.map((r) => r.number));
  });
});

describe("nextSortState", () => {
  it("flips direction when the sorted column is clicked again", () => {
    expect(nextSortState({ key: "company", direction: "asc" }, "company")).toEqual({
      key: "company",
      direction: "desc",
    });
  });

  it("starts a newly clicked column ascending by default", () => {
    expect(nextSortState({ key: "company", direction: "desc" }, "number")).toEqual({
      key: "number",
      direction: "asc",
    });
  });

  it("honours a column's own starting direction", () => {
    expect(
      nextSortState({ key: "company", direction: "asc" }, "updated", { updated: "desc" })
    ).toEqual({ key: "updated", direction: "desc" });
  });
});
