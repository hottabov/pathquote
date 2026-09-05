/**
 * Some options are sold by the section rather than by the piece: the
 * EasyLoader's conveyor and static-table lengths, its busbar and rail, and
 * the MTS's additional travel. A salesperson picking four of them is really
 * specifying 4.8 metres of table, and that is the number the customer asks
 * about -- so the builder shows the running total beside the quantity
 * stepper.
 *
 * The per-unit length is `Option.unitLengthM` (null for an option sold by
 * the piece -- the common case). This module used to read the figure back
 * out of the option's *name* ("Additional 1.2M lengths"); the column
 * replaced that, and the reader is now just `option.unitLengthM * qty`
 * formatted here.
 */

/**
 * Formats a metre total for display: "4.8 m", "6 m", "1.2 m". Trailing
 * zeros are dropped because "6.0 m" of table reads like a measurement
 * someone took, not a count of sections.
 *
 * Rounded to 2dp: 1.2 × 3 is 3.5999999999999996 in binary floating point,
 * and nobody quotes a table to the picometre.
 */
export function formatMetres(metres: number): string {
  return `${Number(metres.toFixed(2))} m`;
}
