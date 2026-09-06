/**
 * Catalogue rows are identified by `id`; `code` is a mutable label. What a
 * row *is* -- machine or table, which order form, how wide, which box an
 * option ticks, which quotation block describes it -- lives in columns
 * (Product.kind/form/specs, Option.role/parentProductId/unitLengthM,
 * *.contentBlockKey), seeded from prisma/seed-data/catalog.json and edited
 * in the catalogue UI. Nothing in the app derives meaning from a code.
 *
 * The one thing a code is still good for is finding a row from *outside*
 * the app, where codes are the only handle there is.
 */

/**
 * A Prisma `where` that finds a product/option by its current code *or* a
 * code it used to have (`legacyCodes`). For importers keyed on external
 * codes -- price sheets, image maps, the seed's catalog.json -- so a
 * database that still holds a row under a retired code is updated in place
 * rather than duplicated. The app itself never looks rows up by code.
 */
export function whereAnyCode(code: string): { OR: [{ code: string }, { legacyCodes: { has: string } }] } {
  return { OR: [{ code }, { legacyCodes: { has: code } }] };
}
