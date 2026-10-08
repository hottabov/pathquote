// Pure country list + ISO 3166-1 alpha-2 helpers over the checked-in table in
// `src/lib/country-names.ts` (generated from `i18n-iso-countries` — Michael
// Wittig, Germany, MIT — deliberately chosen over alternatives per the owner's
// "no Russian-authored libraries" constraint; see that file for why the list
// is generated rather than computed at runtime, and note the package is no
// longer a dependency: generating that table was its last use, so it is
// installed on demand when the list needs regenerating). No `@/lib/db` or `next/*`
// imports — safe to import from a plain `vitest run` and from both server and
// client components (the country <select> needs this list in the browser
// bundle too).
import { COUNTRY_NAMES } from "./country-names";

export type CountryOption = { code: string; name: string };

/** Every ISO 3166-1 alpha-2 country code + English name, sorted by name —
 * the data source for `CountrySelect` and any other country picker. Copied
 * out of the readonly generated table so callers keep the mutable
 * `CountryOption[]` they've always had. */
export const COUNTRIES: CountryOption[] = COUNTRY_NAMES.map(({ code, name }) => ({ code, name }));

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** True when `code` is a real ISO 3166-1 alpha-2 country code (case-sensitive
 * — callers should uppercase first, same convention as `regionCodeSchema` in
 * src/lib/validation/clients.ts). */
export function isValidCountryCode(code: string): boolean {
  return COUNTRY_BY_CODE.has(code);
}

/** The English country name for an ISO alpha-2 `code`, or `undefined` when
 * `code` isn't a recognized country. */
export function countryName(code: string): string | undefined {
  return COUNTRY_BY_CODE.get(code);
}

/** Free-text spellings that don't match their official ISO name
 * (`normalizeCountryInput`'s exact-name-match pass would otherwise miss them)
 * — keyed upper-case, values are ISO alpha-2 codes.
 *
 * Still a best-effort mapper for free-text data, not a fuzzy matcher. The
 * entries below the first group were added from the ACT! import, where 35
 * distinct spellings failed to resolve across 271 contacts. Only the ones that
 * are genuinely another name for a country are here. Deliberately absent, and
 * the distinction is the point:
 *
 *   - typos ("UDSA", "Lativa", "Trinidad and Tabago", "Unitted Kingdom") are
 *     wrong in ACT!, which is the source of truth for contacts. Translating
 *     them here would carry the mistake forever and hide it from whoever could
 *     fix it. Same reasoning as scripts/act-fix-country-usa.py, which corrects
 *     the source rather than mapping around it.
 *   - regions and cities ("North America", "West Indies", "Africa",
 *     "Launceston", "Istanbul", "Québec") are not countries. Guessing a country
 *     from a city is how a client ends up in the wrong manager's list.
 *   - truncations ("United", "P.R.") are ambiguous. "United" could be either
 *     of the two most common values in this data.
 *
 * This matters more than it looks: Company.country decides which manager sees
 * a client (see companyWhereForUser in src/lib/scope.ts), so an unresolved
 * country means a client no country grant can reveal. */
const COUNTRY_ALIASES: Record<string, string> = {
  USA: "US",
  "U.S.A.": "US",
  "U.S.": "US",
  US: "US",
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  UK: "GB",
  "U.K.": "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  AUSTRALIA: "AU",
  "SOUTH KOREA": "KR",
  "NORTH KOREA": "KP",
  RUSSIA: "RU",
  "UAE": "AE",
  "UNITED ARAB EMIRATES": "AE",
  VIETNAM: "VN",
  "VIET NAM": "VN",

  // From the ACT! import. The official ISO names our generated table holds are
  // the long forms ("People's Republic of China", "Türkiye", "Taiwan, Province
  // of China"), and twenty years of free text holds the short ones.
  CHINA: "CN",
  "P.R. CHINA": "CN",
  "PR CHINA": "CN",
  TURKEY: "TR",
  TAIWAN: "TW",
  IRAN: "IR",
  MOLDOVA: "MD",
  MACEDONIA: "MK",
  "NORTH MACEDONIA": "MK",
  "FIJI ISLANDS": "FJ",
  "THE NETHERLANDS": "NL",
  HOLLAND: "NL",
  "SLOVAK REPUBLIC": "SK",
  "KINGDOM OF SAUDI ARABIA": "SA",
  "US VIRGIN ISLANDS": "VI",
  "U.S. VIRGIN ISLANDS": "VI",
  "SERBIA (REPUBLIC OF)": "RS",

  // Australian shorthand, written both ways in the data.
  AUST: "AU",
  "AUST.": "AU",

  // "Korea" alone is formally ambiguous, and in this data it is not: Pathfinder
  // sells industrial cutting machines, South Korea is a real market and North
  // Korea is under sanctions that make it impossible. Mapped on that basis
  // rather than on the string, so if the business ever changes, so does this.
  KOREA: "KR",
  "REPUBLIC OF KOREA": "KR",
  "KOREA, REPUBLIC OF": "KR",
};

const NAME_TO_CODE = new Map(COUNTRIES.map((c) => [c.name.trim().toUpperCase(), c.code]));

/**
 * Best-effort mapper from an existing free-text `Company.country` value
 * (pre-ISO-picker data — "Australia", "USA", "United States", "UK", ...) to
 * an ISO alpha-2 code: an already-valid code passes straight through, then
 * an exact case-insensitive match against the official English country
 * name, then the small alias table above. Returns `null` when nothing
 * matches — callers (see `displayCountry`) fall back to showing the raw
 * text rather than guessing further.
 */
export function normalizeCountryInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (isValidCountryCode(upper)) return upper;

  const byName = NAME_TO_CODE.get(upper);
  if (byName) return byName;

  const byAlias = COUNTRY_ALIASES[upper];
  if (byAlias) return byAlias;

  return null;
}

/**
 * Display helper for a possibly-legacy `Company.country` value: resolves an
 * ISO code (or a normalizable free-text value) to its English name, and
 * falls back to the raw stored value verbatim when it can't be mapped —
 * used by the clients list/detail pages and the document/quotation sheets
 * so a pre-migration free-text country never renders blank.
 */
export function displayCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = normalizeCountryInput(value);
  return code ? (countryName(code) ?? value) : value;
}
