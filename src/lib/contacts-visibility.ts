// Pure row-building for the "Contacts visibility" editor on a user's settings
// page (src/components/settings/contacts-visibility-editor.tsx). Lives apart
// from src/lib/queries/contacts-visibility-admin.ts because that module imports
// `@/lib/db`, which throws without DATABASE_URL -- unusable from the no-database
// test suite. No `@/lib/db` or `next/*` imports.
import { countryName, isValidCountryCode } from "./countries";
import { ALL_COUNTRIES } from "./scope";

export type VisibilityCountryRow = {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** Companies currently carrying this country. */
  companies: number;
  selected: boolean;
};

export type ContactsVisibility = {
  /** The grant is `["*"]`. */
  allCountries: boolean;
  countries: VisibilityCountryRow[];
  /** Companies with no country at all — no grant can reveal them, so they stay
   *  owner-and-admin-only. Shown as a note, not a row. */
  companiesWithoutCountry: number;
};

/** One row of `db.company.groupBy({ by: ["country"], _count: { _all: true } })`. */
export type CompanyCountryGroup = {
  country: string | null;
  _count: { _all: number };
};

/**
 * Turns the per-country company counts and a user's stored grant into the
 * editor's rows.
 *
 * Rows are the union of "countries that have companies" and "countries already
 * granted". The second half is the reason this is not just the group-by: a
 * grant can be set (by the script, or by an earlier save) before any client of
 * that country exists. Built from the group-by alone, the editor would not
 * show it, its Save would send a list without it, and the grant would be erased
 * without the admin ever having seen it. Such a country appears with a count
 * of 0.
 *
 * A group counts toward a country row only when its stored value IS that
 * country's ISO code, exactly. `companyWhereForUser` matches `country IN
 * (grant)` exactly, so a company saved as "United States", "usa" or "us " would
 * not be revealed by a grant of `US` -- showing it inside the `US` count would
 * promise a manager clients they cannot see. Those rows, and a null or empty
 * country, are counted in `companiesWithoutCountry` instead: the one number
 * that says "a grant cannot reach these".
 *
 * Sorted by company count descending, then name, so a long list opens on the
 * countries that matter and the one-stray-record countries sink.
 */
export function buildContactsVisibility(
  groups: readonly CompanyCountryGroup[],
  grant: readonly string[]
): ContactsVisibility {
  const grantedCodes = new Set(grant.filter((code) => isValidCountryCode(code)));
  const counts = new Map<string, number>();
  let companiesWithoutCountry = 0;

  for (const group of groups) {
    const n = group._count._all;
    if (group.country !== null && isValidCountryCode(group.country)) {
      counts.set(group.country, (counts.get(group.country) ?? 0) + n);
    } else {
      companiesWithoutCountry += n;
    }
  }

  const codes = new Set([...counts.keys(), ...grantedCodes]);
  const countries: VisibilityCountryRow[] = [...codes].map((code) => ({
    code,
    name: countryName(code) ?? code,
    companies: counts.get(code) ?? 0,
    selected: grantedCodes.has(code),
  }));
  countries.sort((a, b) => b.companies - a.companies || a.name.localeCompare(b.name));

  return {
    allCountries: grant.includes(ALL_COUNTRIES),
    countries,
    companiesWithoutCountry,
  };
}
