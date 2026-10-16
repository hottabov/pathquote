// The zod-free half of validation/industries.ts: the matching helpers the
// industry pickers run on every keystroke.
//
// These never used zod -- they sat in the same file as the two schemas that
// do, and `IndustryPicker` ("use client", on the client card, the new-client
// form and the builder's "+ New company" panel) imported them from there,
// which put the zod runtime (~380 KB) into those pages' JavaScript
// (PERF-08). Moved here unchanged; industries.ts re-exports them so the
// server side and the existing tests keep their one import.
//
// Rule: no `zod` import in this file.

/**
 * An industry name as typed by a user. 80 characters is generous for the
 * imported list and keeps the value inside the `Industry:` cell on every
 * order form without overflow. Shared with the two schemas in industries.ts.
 */
export const INDUSTRY_NAME_MAX = 80;

/**
 * Comparison key for deduplication. Creating "automotive" when "Automotive"
 * already exists must select the existing row rather than add a near-
 * duplicate -- see `createIndustry`, and the Industry_name_lower_key
 * functional index that backs it in the database.
 */
export function normalizeIndustryName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** An industry as the pickers see it: the row's own name plus every spelling
 * that should also find it. */
export type IndustryMatchable = { name: string; aliases: { name: string }[] };

/**
 * Whether `query` should surface this industry — a substring match against
 * the name or any alias, on the same normalized key `createIndustry` dedupes
 * by, so "retail  TRADE" finds a "Retail trade" alias.
 *
 * Substring rather than prefix because the imported list is full of
 * multi-word rows ("Marine upholstery") an admin thinks of by the second
 * word. Lives here, next to the normalizer it depends on, so both the
 * client-card picker and its tests use one definition of "matches".
 */
export function industryMatchesQuery(industry: IndustryMatchable, query: string): boolean {
  const key = normalizeIndustryName(query);
  if (!key) return true;
  if (normalizeIndustryName(industry.name).includes(key)) return true;
  return industry.aliases.some((alias) => normalizeIndustryName(alias.name).includes(key));
}

/**
 * The alias that made `industry` match, or null when the name itself did.
 *
 * The picker shows this next to the row: typing "Retail trade" and being
 * offered "Retail" with no explanation looks like the wrong result, and the
 * user's next move is to create the duplicate the alias exists to prevent.
 * Name matches win — a row whose own name matches needs no footnote.
 */
export function matchingIndustryAlias(industry: IndustryMatchable, query: string): string | null {
  const key = normalizeIndustryName(query);
  if (!key) return null;
  if (normalizeIndustryName(industry.name).includes(key)) return null;
  return industry.aliases.find((alias) => normalizeIndustryName(alias.name).includes(key))?.name ?? null;
}

/**
 * Whether anything about this industry is *exactly* what was typed, which is
 * what decides whether the picker offers "Create ...". Without the aliases in
 * this check, typing an alias verbatim would offer to create a row that
 * already has that spelling recorded — the precise duplicate aliases exist to
 * stop.
 */
export function industryEqualsQuery(industry: IndustryMatchable, query: string): boolean {
  const key = normalizeIndustryName(query);
  if (!key) return false;
  if (normalizeIndustryName(industry.name) === key) return true;
  return industry.aliases.some((alias) => normalizeIndustryName(alias.name) === key);
}
