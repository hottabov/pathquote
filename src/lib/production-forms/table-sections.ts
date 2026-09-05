/**
 * An EasyLoader is a table built from physical 1.2 metre modules, and this
 * module is the single place that turns a drawn layout into the options the
 * customer is charged for.
 *
 * The direction used to run the other way: a manager picked table-length
 * options by hand, drew sections to match, and a reconciliation gate caught
 * the cases where the two disagreed. The owner's instruction is that the
 * layout is the input and the options are its consequence, so the gate is
 * gone -- not relaxed, but unnecessary, since a mismatch can no longer be
 * expressed.
 *
 * The rule that carries the price: a conveyor section needs a motor, and the
 * motor lives in its first module. So each conveyor section is one Drive
 * Module plus (n-1) plain 1.2m lengths. A static section has no motor at all
 * and is n static lengths. Two conveyor sections mean two drive modules --
 * they are two separate runs of table, each with its own drive.
 */

import type { OptionRole } from "@prisma/client";

/** Every table option is priced and counted per 1.2 metre unit. */
export const SECTION_UNIT_M = 1.2;

/** The most sections one EasyLoader can be split into. Four by the owner's
 * instruction; note the printed order form still has three rows, so a fourth
 * section has nowhere to print until that template is redrawn. */
export const MAX_SECTIONS = 4;

export type SectionSurface = "static" | "conveyor";
export type Section = { lengthM: number; surface: SectionSurface };

/**
 * The kinds of module a table is built from, as `Option.role` names them.
 * Every EasyLoader width has one option per role, scoped to that width by
 * `Option.parentProductId` -- so a derived row is "this item's option with
 * this role", never a code assembled from strings. `setEasyLoaderLayout`
 * does that lookup; tests/catalog.test.ts checks the catalogue has every
 * role for every width.
 */
export const EL_MODULE_ROLE_LIST = ["EL_DRIVE", "EL_CONVEYOR", "EL_STATIC", "EL_BUSBAR", "EL_RAIL"] as const;

export type ElModuleRole = (typeof EL_MODULE_ROLE_LIST)[number];

export const EL_MODULE_ROLES: ReadonlySet<OptionRole> = new Set<OptionRole>(EL_MODULE_ROLE_LIST);

/**
 * Whether an option is one a table layout owns. Used to tell the manager's
 * own selections (roll holder, sync feature, crate) apart from the derived
 * rows when rewriting them, and to render the derived rows read-only in the
 * options editor -- editing a number the builder recomputes on the next
 * click would only ever be undone.
 */
export function isEasyLoaderModuleRole(role: OptionRole | null | undefined): role is ElModuleRole {
  return role !== null && role !== undefined && EL_MODULE_ROLES.has(role);
}

/**
 * Converts a whole number of 1.2m units to metres. A plain
 * `units * SECTION_UNIT_M` can land on 7.199999999999999 instead of 7.2;
 * every unit count here is a whole number of 1.2m lengths, so the true
 * value always has exactly one decimal digit -- round to it.
 */
export function unitsToM(units: number): number {
  return Math.round(units * SECTION_UNIT_M * 10) / 10;
}

/** How many 1.2m modules a section's length is. Rounded rather than divided
 * exactly: 1.2 has no exact binary representation, so a length assembled by
 * repeated addition can sit a hair off the true multiple. */
export function modulesIn(section: Section): number {
  return Math.max(0, Math.round(section.lengthM / SECTION_UNIT_M));
}

export type LayoutTotals = {
  /** One per conveyor section that has any modules at all. */
  driveModules: number;
  /** Conveyor modules after each section's first, which is its drive. */
  conveyorModules: number;
  staticModules: number;
  /** Every physical module, whatever it is -- what the busbar and the
   * travel-platform rail are counted per. */
  totalModules: number;
  totalM: number;
};

export function layoutTotals(sections: Section[]): LayoutTotals {
  let driveModules = 0;
  let conveyorModules = 0;
  let staticModules = 0;

  for (const section of sections) {
    const modules = modulesIn(section);
    if (modules === 0) continue;
    if (section.surface === "conveyor") {
      driveModules += 1;
      conveyorModules += modules - 1;
    } else {
      staticModules += modules;
    }
  }

  const totalModules = driveModules + conveyorModules + staticModules;
  return { driveModules, conveyorModules, staticModules, totalModules, totalM: unitsToM(totalModules) };
}

export type DerivedOption = { role: ElModuleRole; qty: number };

/**
 * The option lines an EasyLoader's layout adds up to, by role. Anything with
 * a quantity of zero is left out rather than written as a zero-quantity
 * line, so a table with no static run simply has no static row.
 *
 * `fabricProCompatible` adds the electrical busbar and the travel-platform
 * support rail, one of each per module -- including the static ones, which
 * the FabricPro still has to travel over.
 */
export function deriveEasyLoaderOptions(sections: Section[], fabricProCompatible: boolean): DerivedOption[] {
  const totals = layoutTotals(sections);
  const derived: DerivedOption[] = [];

  const push = (role: ElModuleRole, qty: number) => {
    if (qty > 0) derived.push({ role, qty });
  };

  push("EL_DRIVE", totals.driveModules);
  push("EL_CONVEYOR", totals.conveyorModules);
  push("EL_STATIC", totals.staticModules);

  if (fabricProCompatible) {
    push("EL_BUSBAR", totals.totalModules);
    push("EL_RAIL", totals.totalModules);
  }

  return derived;
}
