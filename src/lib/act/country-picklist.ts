// A PathQuote company's country as ACT! will take it on a new contact.
//
// ACT!'s contact `businessAddress/country` is limited to the "Countries"
// picklist (`isLimitToList: true`, COUNTRIES_PICKLIST_ID in
// src/lib/act/client.ts, from RAW/ACT/meta/fields_contact.json -- a local
// capture, not committed), so a value written there has to be spelled exactly
// as one of the list's items. Company.country holds ISO 3166-1 alpha-2 (and,
// on rows older than the ISO picker, free text). The items have never been
// read from this repo -- no capture of them exists -- so nothing here assumes
// how ACT! spells any country. The drain reads the list once per pass
// (ActClient.picklistItems) and this module matches it.
//
// THE MATCH IS countries.ts'S OWN READING. An item is a spelling of a
// country when normalizeCountryInput (src/lib/countries.ts) -- the function
// the inbound sync reads ACT!'s free-text country with (mapContact in
// src/lib/act/map.ts) -- resolves it to that ISO code: an ISO code itself,
// the official English name, or one of its aliases for ACT!'s colloquial
// names ("China", "Turkey", "Korea", "USA"...). So every value this can
// return is, by construction, one the next inbound sync reads back as the
// same country. An item that does not resolve is never chosen, and a country
// no item resolves to is left out of the body, not guessed: a contact created
// without a country is visible in ACT!, one created in the wrong country is
// not.
//
// Pure, for the suite (see vitest.config.ts).

import { countryName, normalizeCountryInput } from "@/lib/countries";
import type { ActPicklistItem } from "@/lib/act/types";

/**
 * The Countries picklist item to send for `country` -- Company.country, ISO
 * or legacy free text -- or null when the country is blank, does not
 * resolve, or no item of `items` resolves to it.
 *
 * The item's value is returned exactly as ACT! listed it, untrimmed: a list
 * limited to its items compares what it is sent with what it holds.
 *
 * MORE THAN ONE ITEM can resolve to one country -- "United States" and
 * "USA", say. Any of them is safe to send: each is on the list, and each
 * reads back as the same ISO code. The one chosen is the item spelled as the
 * official English name (countryName), when there is one, and otherwise the
 * first in the list's own order -- the order an administrator keeps it in --
 * so the same list always gives the same answer.
 */
export function actCountryValue(
  country: string | null,
  items: readonly Pick<ActPicklistItem, "value">[],
): string | null {
  const iso = normalizeCountryInput(country);
  if (!iso) return null;
  const candidates = items
    .map((item) => item.value)
    .filter((value): value is string => typeof value === "string" && normalizeCountryInput(value) === iso);
  if (candidates.length === 0) return null;
  const official = countryName(iso)?.toUpperCase();
  return candidates.find((value) => value.trim().toUpperCase() === official) ?? candidates[0];
}

/**
 * How much of PathQuote's country list a picklist covers: of every ISO code
 * countries.ts knows, how many have an item (`mapped`) and which do not
 * (`missing`, ISO codes, sorted). For the drain's log line on the first pass
 * that reads the list -- the first time anyone sees what the list holds.
 */
export function countryPicklistCoverage(
  isoCodes: readonly string[],
  items: readonly Pick<ActPicklistItem, "value">[],
): { mapped: number; missing: string[] } {
  const missing = isoCodes.filter((code) => actCountryValue(code, items) === null).sort();
  return { mapped: isoCodes.length - missing.length, missing };
}
