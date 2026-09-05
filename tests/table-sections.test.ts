import { describe, it, expect } from "vitest";
import {
  deriveEasyLoaderOptions,
  EL_MODULE_ROLE_LIST,
  EL_MODULE_ROLES,
  isEasyLoaderModuleRole,
  layoutTotals,
  modulesIn,
  unitsToM,
  MAX_SECTIONS,
  type Section,
} from "../src/lib/production-forms/table-sections";

const conveyor = (modules: number): Section => ({ lengthM: unitsToM(modules), surface: "conveyor" });
const staticRun = (modules: number): Section => ({ lengthM: unitsToM(modules), surface: "static" });

describe("unitsToM", () => {
  it("keeps one decimal digit rather than a float's tail", () => {
    // 6 * 1.2 is 7.199999999999999 in binary floating point.
    expect(unitsToM(6)).toBe(7.2);
    expect(unitsToM(11)).toBe(13.2);
  });
});

describe("modulesIn", () => {
  it("counts a length back to whole modules", () => {
    expect(modulesIn(conveyor(5))).toBe(5);
    expect(modulesIn(staticRun(1))).toBe(1);
  });

  it("survives a length assembled by repeated addition", () => {
    // What five separate +1.2 clicks used to leave behind.
    expect(modulesIn({ lengthM: 1.2 + 1.2 + 1.2 + 1.2 + 1.2, surface: "conveyor" })).toBe(5);
  });

  it("treats an empty section as no modules", () => {
    expect(modulesIn({ lengthM: 0, surface: "conveyor" })).toBe(0);
  });
});

describe("layoutTotals", () => {
  it("gives each conveyor run its own drive module", () => {
    const totals = layoutTotals([conveyor(5), conveyor(5)]);
    expect(totals.driveModules).toBe(2);
    expect(totals.conveyorModules).toBe(8);
  });

  it("gives a static run no drive module at all", () => {
    const totals = layoutTotals([staticRun(3)]);
    expect(totals.driveModules).toBe(0);
    expect(totals.staticModules).toBe(3);
  });

  it("counts a single-module conveyor run as just its drive", () => {
    const totals = layoutTotals([conveyor(1)]);
    expect(totals.driveModules).toBe(1);
    expect(totals.conveyorModules).toBe(0);
  });

  it("ignores a section with no modules", () => {
    const totals = layoutTotals([conveyor(2), { lengthM: 0, surface: "conveyor" }]);
    expect(totals.driveModules).toBe(1);
    expect(totals.totalModules).toBe(2);
  });

  it("is empty for a table with no sections", () => {
    expect(layoutTotals([])).toMatchObject({ totalModules: 0, totalM: 0, driveModules: 0 });
  });
});

// The owner's own worked example, kept whole: two conveyor runs of five
// modules each and one static module. It is the specification for how a
// drawn table becomes money, so it is asserted end to end rather than only
// in pieces.
describe("the owner's worked example", () => {
  const sections = [conveyor(5), conveyor(5), staticRun(1)];

  it("totals 13.2 m across 11 modules", () => {
    const totals = layoutTotals(sections);
    expect(totals.totalModules).toBe(11);
    expect(totals.totalM).toBe(13.2);
  });

  it("prices as 2 drive, 8 conveyor and 1 static", () => {
    expect(deriveEasyLoaderOptions(sections, false)).toEqual([
      { role: "EL_DRIVE", qty: 2 },
      { role: "EL_CONVEYOR", qty: 8 },
      { role: "EL_STATIC", qty: 1 },
    ]);
  });

  it("adds a busbar and a rail per module when a FabricPro runs the table", () => {
    const derived = deriveEasyLoaderOptions(sections, true);
    expect(derived).toContainEqual({ role: "EL_BUSBAR", qty: 11 });
    expect(derived).toContainEqual({ role: "EL_RAIL", qty: 11 });
  });
});

describe("deriveEasyLoaderOptions", () => {
  it("writes no row at all for a kind the table has none of", () => {
    const roles = deriveEasyLoaderOptions([conveyor(2)], false).map((d) => d.role);
    expect(roles).not.toContain("EL_STATIC");
  });

  it("prices nothing for an empty table", () => {
    expect(deriveEasyLoaderOptions([], true)).toEqual([]);
  });

  it("only ever writes module roles", () => {
    const derived = deriveEasyLoaderOptions([conveyor(2), staticRun(1)], true);
    expect(derived).toHaveLength(5);
    for (const { role } of derived) {
      expect(EL_MODULE_ROLES.has(role), role).toBe(true);
    }
  });
});

describe("module roles", () => {
  it("recognises every role the builder writes", () => {
    for (const role of EL_MODULE_ROLE_LIST) {
      expect(isEasyLoaderModuleRole(role), role).toBe(true);
    }
    expect(new Set(EL_MODULE_ROLE_LIST)).toEqual(EL_MODULE_ROLES);
  });

  it("leaves the manager's own accessories alone", () => {
    // The roll holder, sync feature and crate are picked by hand and must
    // survive a redraw of the table.
    for (const role of ["EL_SYNC", "CRATE", "EL_ROLL_HOLDER", "EL_ROLL_FEED"] as const) {
      expect(isEasyLoaderModuleRole(role), role).toBe(false);
    }
  });

  it("treats an option with no role as the manager's own", () => {
    expect(isEasyLoaderModuleRole(null)).toBe(false);
    expect(isEasyLoaderModuleRole(undefined)).toBe(false);
  });
});

describe("MAX_SECTIONS", () => {
  it("is four, per the owner", () => {
    expect(MAX_SECTIONS).toBe(4);
  });
});
