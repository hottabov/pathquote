/**
 * How the builder's compatible-options read is split back out per product
 * after being fetched in ONE query for every product on the quote.
 *
 * `listCompatibleOptions` (src/lib/queries/documents-pickers.ts) used to run
 * once per distinct product on the page -- 5-8 statements each, since every
 * nested relation is its own round trip -- and a quote with three machines
 * paid that three times over for rows that overlap almost entirely (most
 * options are series-level and shared). The page now fetches every option
 * compatible with ANY of its products at once, and this function hands each
 * product the subset it would have got from its own query.
 *
 * The membership test here is `compatibilityOrFilter` (src/lib/catalog-compat.ts)
 * applied in memory: an option belongs to a key when one of its compat rows
 * names that key's series, or names that key's product. Keep the two in step
 * -- the pure test in tests/compatible-options-partition.test.ts is what
 * checks they still agree.
 *
 * Pure and database-free on purpose: the SQL lives in the query module, and
 * this is the part worth unit-testing.
 */

export type CompatKey = {
  /** How the page keys the result -- `productId`, or `series:<seriesId>`
   * when the product no longer resolves (see the page's own comment). */
  key: string;
  productId: string | null;
  seriesId: string | null;
};

export type CompatRow = { seriesId: string | null; productId: string | null };

/**
 * Whether an option whose compat rows are `rows` is compatible with `key` --
 * the same question `compatibilityOrFilter` asks the database.
 */
export function isCompatibleWith(rows: readonly CompatRow[], key: CompatKey): boolean {
  if (!key.productId && !key.seriesId) return false;
  return rows.some(
    (row) =>
      (key.seriesId !== null && row.seriesId === key.seriesId) ||
      (key.productId !== null && row.productId === key.productId)
  );
}

/**
 * Splits one sorted option list into a list per key, preserving the input
 * order within each. Every key gets an entry, so a caller can index the
 * result without a fallback: a key no option matches gets `[]`, exactly as
 * its own query would have returned nothing. Options carry their compat rows
 * for the test and nothing else is read off them.
 */
export function partitionByCompatKey<T extends { compat: readonly CompatRow[] }>(
  keys: readonly CompatKey[],
  options: readonly T[]
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const key of keys) {
    result[key.key] = options.filter((option) => isCompatibleWith(option.compat, key));
  }
  return result;
}
