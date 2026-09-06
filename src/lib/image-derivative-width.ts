/**
 * The pure width-selection half of src/lib/image-derivatives.ts, split into
 * its own module so client components (Avatar, ItemsList, ...) can pick a
 * `?w=` value without pulling that module's `fs`/`crypto`/lazy-`sharp`
 * imports into a browser bundle. image-derivatives.ts re-exports
 * `DERIVATIVE_WIDTHS`/`DerivativeWidth` from here, so this is still the one
 * place the closed set of generated widths is defined.
 */

/**
 * Widths a caller may ask for, in *device* pixels (so a 64px-wide thumbnail
 * on a 2× display asks for 128). Closed set rather than a free integer:
 * every accepted value writes a file to disk (see `ensureDerivative`), so an
 * open range would let an unauthenticated cache-buster or a crawler fill the
 * uploads volume with thousands of near-identical derivatives.
 */
export const DERIVATIVE_WIDTHS = [64, 128, 256, 512] as const;

export type DerivativeWidth = (typeof DERIVATIVE_WIDTHS)[number];

/**
 * The smallest generated width that covers `targetPx` device pixels (e.g.
 * pass `boxPx * 2` for a 2× source), or the largest available width when
 * even that isn't enough — never returns something *smaller* than asked, so
 * a caller never has to fall back to the print-resolution original just
 * because its box didn't land on an exact generated size.
 */
export function pickDerivativeWidth(targetPx: number): DerivativeWidth {
  for (const width of DERIVATIVE_WIDTHS) {
    if (width >= targetPx) return width;
  }
  return DERIVATIVE_WIDTHS[DERIVATIVE_WIDTHS.length - 1];
}
