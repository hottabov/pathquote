// The one place that decides whether a sync may change an existing value.
//
// It may not. A sync fills blanks and nothing else: what a salesperson typed
// into PathQuote is never silently replaced by what ACT! happens to hold. The
// full ACT! payload is kept in the ActSnapshot table, so a divergence can be
// shown to a person without either version being destroyed.
//
// Kept as one tiny function rather than inlined at each call site so that
// "can a sync overwrite this?" has exactly one answer, and changing it is a
// decision rather than an oversight in one branch.

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * The subset of `incoming` that may be written over `existing`: fields listed
 * in `fields` that are blank on the existing record and non-blank on the
 * incoming one.
 *
 * Returns a patch, not a merged record, so a caller can tell "nothing changed"
 * from "changed back to the same value" and skip the write entirely.
 */
export function fillOnlyEmpty<T extends Record<string, unknown>>(
  existing: Partial<T>,
  incoming: Partial<T>,
  fields: readonly (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const field of fields) {
    if (!isBlank(existing[field])) continue;
    if (isBlank(incoming[field])) continue;
    patch[field] = incoming[field];
  }
  return patch;
}
