/**
 * The travel-platform rail and the electrical power rail a FabricPro runs on.
 *
 * These are not a FabricPro part. They are bolted to the EasyLoader table the
 * FabricPro travels over, which is why the EasyLoader builder's "FabricPro
 * compatible" tick is what puts them on the quote (one busbar and one support
 * rail per 1.2m module -- see `deriveEasyLoaderOptions`). Their *length* is
 * the same fact stated in metres, so nobody types it.
 *
 * They print on the EasyLoader form of every table marked FabricPro
 * compatible, at that table's own length (John, 2026-09: an 8.4 m table gets
 * 8.4 m of rail and 8.4 m of power rail). Nothing is paired with a FabricPro
 * and nothing prints on the FabricPro form: a table is built with its rails
 * whether or not a FabricPro is on the same quote.
 */

import { layoutTotals, type Section } from "./table-sections";

/** The parts of an EasyLoader's production spec that decide rail length. */
export type RailSource = {
  fabricProCompatible?: boolean | null;
  sections?: Section[] | null;
};

/** Rounds to the one decimal digit a whole number of 1.2m modules can produce. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Metres of rail this one table needs, or null when it is not FabricPro
 * compatible or has not been laid out yet. Both rails are always the same
 * length (Jeff, 2026-09-11: "Electrical power rail counts the same, right?
 * -- Yep. Always the same number"), so there is one figure, not two.
 */
export function railLengthM(table: RailSource): number | null {
  if (table.fabricProCompatible !== true) return null;
  const totalM = layoutTotals(table.sections ?? []).totalM;
  return totalM > 0 ? round1(totalM) : null;
}
