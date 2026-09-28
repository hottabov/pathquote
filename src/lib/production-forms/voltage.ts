/**
 * The supply voltage a machine is ordered for, as agreed at the catalogue
 * review with John.
 *
 * - M-Series: 400 V is the machine as built. 220 V and 480 V sites need a
 *   transformer, and the transformer is not a separate choice: picking the
 *   voltage puts it on the quote (`transformerCodeFor`).
 * - X-Calibre: built for 400 V or 480 V, no transformer. The salesperson
 *   must say which.
 * - L-Series: 220/230 V unless written in otherwise.
 *
 * On the M-Series and X-Calibre the voltage is required: the form spec lists
 * it in `requires`, so a quote cannot be finalized without it.
 */

export const M_SERIES_VOLTAGES = ["220V", "400V", "480V"] as const;
export const X_CALIBRE_VOLTAGES = ["400V", "480V"] as const;

export type MSeriesVoltage = (typeof M_SERIES_VOLTAGES)[number];

/** What an L-Series is ordered for when nobody says otherwise. */
export const L_SERIES_DEFAULT_VOLTAGE = "220/230";

/**
 * The transformer an M-Series ships with at each supply voltage, by the
 * code the catalogue sells it under (`TR220`: 220 V in, `TR480`: 480 V in;
 * both role TRANSFORMER, told apart by code -- the same convention the power
 * row on the order forms prints them by). 400 V needs none.
 */
const TRANSFORMER_CODE: Record<MSeriesVoltage, string | null> = {
  "220V": "TR220",
  "400V": null,
  "480V": "TR480",
};

export function isMSeriesVoltage(value: unknown): value is MSeriesVoltage {
  return typeof value === "string" && (M_SERIES_VOLTAGES as readonly string[]).includes(value);
}

/** The transformer code an M-Series at `voltage` needs, or null for none (or no voltage yet). */
export function transformerCodeFor(voltage: unknown): string | null {
  return isMSeriesVoltage(voltage) ? TRANSFORMER_CODE[voltage] : null;
}
