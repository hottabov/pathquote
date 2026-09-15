/**
 * The Machine Transfer System, and the one piece of arithmetic that decides
 * what it costs.
 *
 * An MTS is a rail that carries a cutter between tables. The `MTS` option is
 * the system, and its price covers a travel distance of up to nine metres.
 * Past that the extra rail is sold by the metre as `MTS-M` (role
 * `MTS_TRAVEL`, `unitLengthM` 1).
 *
 * The salesperson's job is therefore to tick MTS and say how long the run is.
 * The per-metre line is a consequence of that number, never a thing to pick:
 * `MTS-M` on its own is a pile of rail with nothing to mount it to, and an
 * `MTS` whose extra metres were forgotten is a quote that under-charges.
 * Both are avoided the same way the EasyLoader's modules are -- the input is
 * the length, the lines are derived from it (see `table-sections.ts`).
 *
 * The length lives on the `MTS` line's `attributes.metres`, where it already
 * was: the M-Series form prints it at M73 beside "Travel distance, end to end
 * of tables", and the options editor already renders the field from the
 * option's `attributeSchema`. Nothing new had to be stored.
 */

/** The key the travel distance is stored under on the MTS option line. */
export const MTS_METRES_KEY = "metres";

/**
 * The travel-length input the options editor renders on an MTS row.
 *
 * Declared here rather than in the catalogue's `Option.attributeSchema`,
 * which is where an option's extra inputs normally come from. An MTS has a
 * travel distance the way it has a price: it is what the thing is, not an
 * admin's decision about it, and the number drives both what the quote
 * charges (`mtsTravelMetres`) and what the workshop builds (the M-Series
 * form prints it at M73). Leaving it in a hand-edited JSON blob would mean
 * one cleared field silently stops the extra metres being billed.
 */
export const MTS_METRES_FIELD = {
  key: MTS_METRES_KEY,
  label: "Travel (m)",
  type: "number",
} as const;

/** Travel distance, in metres, the MTS option's own price already covers. */
export const MTS_INCLUDED_M = 9;

/**
 * How many `MTS-M` metres an MTS run of `metres` needs on top of the system
 * itself. Zero at or under the included distance, and zero for a missing or
 * unreadable length -- a number nobody typed is not a reason to charge for
 * rail.
 *
 * Rounded up: `MTS-M` is sold per whole metre (`unitLengthM` 1), so a 12.5
 * metre run buys four extra metres, not three and a half.
 */
export function mtsTravelMetres(metres: unknown): number {
  const length = typeof metres === "number" ? metres : Number(metres);
  if (!Number.isFinite(length) || length <= MTS_INCLUDED_M) return 0;
  return Math.ceil(length - MTS_INCLUDED_M);
}

/** The shape `normaliseMtsSelections` needs of an option selection. */
export type MtsSelection = {
  optionId: string;
  qty: number;
  attributes?: Record<string, unknown> | undefined;
};

/**
 * Applies the two MTS rules to a set of option selections, before anything
 * is written.
 *
 * 1. **The manager never picks `MTS-M`.** Every `MTS_TRAVEL` selection is
 *    dropped, whether it came from an old page, a replayed request, or a
 *    quote saved before this rule existed. The metres it should have are
 *    returned instead, for the caller to add back as one derived line.
 * 2. **One MTS, whatever its length.** Its quantity is forced to 1. The
 *    builder no longer offers a quantity at all, so a 2 arriving from
 *    anywhere is stale rather than meant, and it would double a
 *    fifteen-thousand-dollar line while the length beside it said nothing
 *    had changed.
 *
 * `travelMetres` is 0 when there is no MTS in the selection at all: rail
 * with nothing to mount it to is not a thing to charge for, so losing the
 * MTS loses the extra metres with it.
 *
 * Pure, and separated from the action that calls it, because this is the
 * arithmetic that decides what a quote charges for an MTS -- the one part of
 * it that has to be readable on its own and tested without a database.
 */
export function normaliseMtsSelections<T extends MtsSelection>(
  selections: T[],
  roleOf: (optionId: string) => string | null | undefined
): { selections: T[]; travelMetres: number } {
  const kept = selections
    .filter((selection) => roleOf(selection.optionId) !== "MTS_TRAVEL")
    .map((selection) => (roleOf(selection.optionId) === "MTS" ? { ...selection, qty: 1 } : selection));

  const mts = kept.find((selection) => roleOf(selection.optionId) === "MTS");

  return { selections: kept, travelMetres: mts ? mtsTravelMetres(readMtsMetres(mts.attributes)) : 0 };
}

/** The travel distance recorded on an MTS option line, if it carries one. */
export function readMtsMetres(attributes: unknown): number | undefined {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return undefined;
  const raw = (attributes as Record<string, unknown>)[MTS_METRES_KEY];
  const metres = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(metres) ? metres : undefined;
}
