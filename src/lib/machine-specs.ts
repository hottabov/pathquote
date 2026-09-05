// The quotation's one-line machine spec and the width placeholders, read
// off `Product.specs` (see src/lib/validation/product-specs.ts). Until
// migration z31 this module parsed the figures out of the product *code*
// ("M3390" -> 3cm x 390cm); the code is a label now and the columns are the
// fact, so this is a pair of pure formatters over `ProductSpecs`. Never
// touches the DB or `next/*` -- same discipline as sheet-data.ts and
// quotation-data.ts -- so a plain `vitest run` of it never needs
// `DATABASE_URL` set.
import type { ProductSpecs } from "@/lib/validation/product-specs";

/**
 * A human-readable one-line spec summary, e.g. `"M-Series Cutting Machine,
 * 3cm compressed lay height, 390cm cutting width"` when both the height and
 * the width are known, or `"L-Series Cutting Machine with 320cm cutting
 * width"` when only the width is (the L-Series has no lay height to report).
 * `null` when there is no width -- never a sentence with a blank dimension
 * spliced in. The caller decides whether the product is a cutting machine
 * at all (`Product.kind`); a spreader carries a `cutWidthCm` too and must
 * not be introduced as one.
 */
export function machineSpecSentence(seriesName: string, specs: ProductSpecs): string | null {
  const { cutHeightCm, cutWidthCm } = specs;
  if (cutWidthCm === undefined) return null;
  if (cutHeightCm !== undefined) {
    return `${seriesName} Cutting Machine, ${cutHeightCm}cm compressed lay height, ${cutWidthCm}cm cutting width`;
  }
  return `${seriesName} Cutting Machine with ${cutWidthCm}cm cutting width`;
}

/**
 * Placeholder variables for the equipment that has a width but no cutting
 * spec: `{{tableWidthMm}}` (EasyLoader / EasyFeeder) and `{{paperWidthMm}}`
 * (Punchline). Only the figures that are present are returned, as strings,
 * so a missing one line-strips the way every unresolved token does (see
 * `substitutePlaceholders` in quotation-data.ts).
 */
export function extraSpecVars(specs: ProductSpecs): Record<string, string> {
  const vars: Record<string, string> = {};
  if (specs.tableWidthMm !== undefined) vars.tableWidthMm = String(specs.tableWidthMm);
  if (specs.paperWidthMm !== undefined) vars.paperWidthMm = String(specs.paperWidthMm);
  return vars;
}
