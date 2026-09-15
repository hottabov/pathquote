import { describe, it, expect } from "vitest";
import type { OptionRole } from "@prisma/client";
import {
  selectionFromLine,
  selectionsFromLines,
  withDerivedSelections,
  type SelectionLine,
  type SelectionState,
} from "../src/lib/option-selections";
import { EL_MODULE_ROLES } from "../src/lib/production-forms/table-sections";

const line = (
  refId: string | null,
  qty: number,
  role: OptionRole | null,
  attributes: Record<string, string | number> | null = null
): SelectionLine => ({ refId, qty, role, attributes });

/** The EasyLoader's lock: its table modules plus the per-metre MTS rail,
 * exactly as `items-list.tsx` assembles it. */
const LOCKED = new Set<OptionRole>([...EL_MODULE_ROLES, "MTS_TRAVEL"]);

/**
 * `ItemOptionsEditor.isLocked`, rebuilt here: an option's role is looked up
 * in the catalogue rows the panel was handed *and* in the item's own lines,
 * so an option stays locked even after the layout has stopped deriving it --
 * which is what lets the stale row be dropped rather than left ticked.
 */
const lockedBy = (lines: SelectionLine[], catalogue: Record<string, OptionRole> = CATALOGUE) => {
  const roleById = new Map<string, OptionRole | null>(lines.filter((l) => l.refId).map((l) => [l.refId!, l.role]));
  for (const [id, role] of Object.entries(catalogue)) roleById.set(id, role);
  return (id: string) => {
    const role = roleById.get(id);
    return role !== null && role !== undefined && LOCKED.has(role);
  };
};

/** The EasyLoader options this item's panel lists, by id. */
const CATALOGUE: Record<string, OptionRole> = {
  drive: "EL_DRIVE",
  conveyor: "EL_CONVEYOR",
  static: "EL_STATIC",
  holder: "EL_ROLL_HOLDER",
  rail: "MTS_TRAVEL",
};

const picked = (qty = 1, attributes: Record<string, string> = {}): SelectionState => ({ qty, attributes });

describe("selectionFromLine", () => {
  it("holds attribute values as strings, whatever the line stored", () => {
    expect(selectionFromLine(line("mts", 1, "MTS", { metres: 12.5 }))).toEqual({
      qty: 1,
      attributes: { metres: "12.5" },
    });
  });

  it("reads a line with no attributes as no attributes", () => {
    expect(selectionFromLine(line("a", 3, null))).toEqual({ qty: 3, attributes: {} });
  });
});

describe("selectionsFromLines", () => {
  it("keys by option id and drops a line with no catalogue row to resubmit", () => {
    const map = selectionsFromLines([line("a", 2, null), line(null, 9, null)]);
    expect([...map.keys()]).toEqual(["a"]);
    expect(map.get("a")).toEqual({ qty: 2, attributes: {} });
  });
});

describe("withDerivedSelections", () => {
  it("ticks a module the layout has just derived, without waiting for the panel to reopen", () => {
    // The bug: a section switched to static put EL_STATIC on the item, but
    // the panel -- whose state was read when it opened -- still showed the
    // static row unticked and a drive module that no longer existed.
    const lines = [line("drive", 2, "EL_DRIVE"), line("static", 1, "EL_STATIC")];
    const stale = new Map([
      ["drive", picked(3)],
      ["holder", picked(1)],
    ]);

    const merged = withDerivedSelections(stale, lines, lockedBy(lines));

    expect(merged.get("static")).toEqual({ qty: 1, attributes: {} });
    expect(merged.get("drive")).toEqual({ qty: 2, attributes: {} });
    expect(merged.get("holder")).toEqual({ qty: 1, attributes: {} });
  });

  it("drops a derived row the item no longer has", () => {
    // Every conveyor section turned static: there is no drive module left to
    // charge for, so the row the panel was holding has to go.
    const lines = [line("static", 4, "EL_STATIC")];
    const stale = new Map([["drive", picked(2)], ["static", picked(1)]]);

    const merged = withDerivedSelections(stale, lines, lockedBy(lines));

    expect(merged.has("drive")).toBe(false);
    expect(merged.get("static")).toEqual({ qty: 4, attributes: {} });
  });

  it("leaves the manager's own picks exactly as the panel has them", () => {
    // An accessory ticked but not yet saved must survive a layout change
    // happening above it -- that edit is the whole reason the panel is open.
    const lines = [line("drive", 1, "EL_DRIVE"), line("holder", 1, "EL_ROLL_HOLDER")];
    const mine = new Map([["crate", picked(2, { note: "flat pack" })]]);

    const merged = withDerivedSelections(mine, lines, lockedBy(lines));

    expect(merged.get("crate")).toEqual({ qty: 2, attributes: { note: "flat pack" } });
    // A roll holder is the manager's to pick, so the item's own line for one
    // does not overwrite -- or reinstate -- what the panel holds.
    expect(merged.has("holder")).toBe(false);
  });

  it("carries a derived row's attributes across", () => {
    const lines = [line("rail", 4, "MTS_TRAVEL", { metres: 4 })];
    const merged = withDerivedSelections(new Map(), lines, lockedBy(lines));
    expect(merged.get("rail")).toEqual({ qty: 4, attributes: { metres: "4" } });
  });

  it("locks nothing when the item has no derived roles at all", () => {
    const lines = [line("a", 1, "L_TOOL")];
    const mine = new Map([["a", picked(5)]]);
    const merged = withDerivedSelections(mine, lines, lockedBy(lines, {}));
    // A hand-picked option keeps the quantity being typed into it, even
    // though the saved line says otherwise.
    expect(merged.get("a")).toEqual({ qty: 5, attributes: {} });
  });
});
