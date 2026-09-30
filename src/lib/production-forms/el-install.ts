/**
 * What installing an EasyLoader costs, worked out from the table it is.
 *
 * `SVC-EL-INSTALL` is priced per hour of work: its catalogue price in a
 * region is the hourly rate, and the hours follow from the modules the
 * table is built from (Vadym, 2026-09-30):
 *
 *   - every drive module takes 2 hours;
 *   - every other module -- a plain conveyor length or a static one --
 *     takes 0.75 hours.
 *
 * The busbar and the FabricPro rail are not modules and add nothing.
 *
 * So three sections of 6 conveyor, 3 conveyor and 1 static module are two
 * drive modules and eight others: 2 x 2 + 8 x 0.75 = 10 hours, and at $260
 * an hour the line is $2,600.
 *
 * The option is sold on the EasyLoader item itself, one per table, so each
 * table on a quote is priced from its own layout. The manager only ticks it:
 * the quantity is always one and the price is this arithmetic, recomputed
 * whenever the table is redrawn (`setEasyLoaderLayout`) or the options are
 * saved (`setItemOptions`). The option is found by its role, `EL_INSTALL`,
 * never by its code or name, which an admin may change.
 */

import { layoutTotals, type Section } from "./table-sections";

export const EL_INSTALL_HOURS_PER_DRIVE = 2;
export const EL_INSTALL_HOURS_PER_MODULE = 0.75;

/**
 * Hours to install a table of these sections. Counted in quarter hours and
 * divided once at the end, so the result is exact rather than a sum of
 * floating-point 0.75s.
 */
export function easyLoaderInstallHours(sections: Section[]): number {
  const { driveModules, conveyorModules, staticModules } = layoutTotals(sections);
  const quarters =
    driveModules * EL_INSTALL_HOURS_PER_DRIVE * 4 + (conveyorModules + staticModules) * EL_INSTALL_HOURS_PER_MODULE * 4;
  return quarters / 4;
}

/** "10 hrs", "9.75 hrs", "1 hr". */
export function formatInstallHours(hours: number): string {
  return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
}
