/**
 * The travel-platform rail and the electrical power rail a FabricPro runs on.
 *
 * These are not a FabricPro part. They are bolted to the EasyLoader table the
 * FabricPro travels over, which is why the EasyLoader builder's "FabricPro
 * compatible" tick is what puts them on the quote (one busbar and one support
 * rail per 1.2m module -- see `deriveEasyLoaderOptions`). Their *length* is
 * the same fact stated in metres, so nobody should be typing it twice.
 *
 * **One FabricPro runs over one table.** It cannot straddle two, so the
 * lengths are per table and never a sum: a quote with two tables and two
 * FabricPros is two independent pairs, and printing 12 m on both sheets
 * because the tables add up to 12 m would have the workshop cut twice the
 * rail and fit neither machine. `assignRails` does the pairing, positionally
 * and with no manager input -- tables and FabricPros are both read in
 * document order, first with first.
 *
 * Where the length prints is the production manager's rule: stores pick the
 * rail parts by length for whoever is building the FabricPro, so it belongs
 * on the FabricPro form whenever one claims the table. A compatible table
 * *nobody* claims -- the customer already owns their FabricPro, or bought
 * three tables and two machines -- points at itself instead, and prints on
 * its own EasyLoader form, where it is at least in front of someone.
 */

import { layoutTotals, type Section } from "./table-sections";

/** The parts of an EasyLoader's production spec that decide rail length. */
export type RailSource = {
  fabricProCompatible?: boolean | null;
  sections?: Section[] | null;
};

/** One EasyLoader on the quote, as the pairing sees it. */
export type RailTable = RailSource & { id: string; code: string };

/**
 * The table one form prints its rail lengths off: the table a FabricPro was
 * paired with, or -- on an unclaimed table's own form -- that table itself.
 * `lengthM` is null while the table has no layout yet, which is a blank to
 * fill in rather than a reason to hide the rows.
 */
export type RailAssignment = { tableId: string; tableCode: string; lengthM: number | null };

/** Rounds to the one decimal digit a whole number of 1.2m modules can produce. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Whether a FabricPro can be paired with this table at all. */
function isCompatible(table: RailSource): boolean {
  return table.fabricProCompatible === true;
}

/**
 * Metres of rail this one table needs, or null when it is not FabricPro
 * compatible or has not been laid out yet. Both rails are always the same
 * length (Jeff, 2026-09-11: "Electrical power rail counts the same, right?
 * -- Yep. Always the same number"), so there is one figure, not two.
 */
export function railLengthM(table: RailSource): number | null {
  if (!isCompatible(table)) return null;
  const totalM = layoutTotals(table.sections ?? []).totalM;
  return totalM > 0 ? round1(totalM) : null;
}

/**
 * Which table each form reads its rail lengths off, keyed by the item id of
 * the form that prints them.
 *
 * FabricPro ids in document order take compatible tables in document order.
 * What is left over is deliberate in both directions: a FabricPro with no
 * compatible table gets no entry (the form prints empty rail rows for
 * someone to fill in rather than a number invented from another machine's
 * table), and a compatible table with no FabricPro is keyed by its own id
 * so its EasyLoader form prints them instead. An incompatible table is never
 * keyed at all -- it carries no rails to print.
 */
export function assignRails(tables: RailTable[], fabricProItemIds: string[]): Map<string, RailAssignment> {
  const assignment = (table: RailTable): RailAssignment => ({
    tableId: table.id,
    tableCode: table.code,
    lengthM: railLengthM(table),
  });

  const compatible = tables.filter(isCompatible);
  const rails = new Map<string, RailAssignment>();

  compatible.forEach((table, index) => {
    const fabricProId = fabricProItemIds[index];
    rails.set(fabricProId ?? table.id, assignment(table));
  });

  return rails;
}
