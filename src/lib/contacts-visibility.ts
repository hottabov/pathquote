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

export type ContactsAccessSummary = {
  /** `none` is the dangerous one: nothing ticked, so the user sees almost no
   *  clients. The editor renders it as a warning, not as a neutral note. */
  tone: "all" | "some" | "none";
  /** What the current, possibly unsaved, selection means in plain words. */
  summary: string;
  /** Present only for `none`: why that is probably not what the admin meant. */
  warning: string | null;
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Restates the working selection as its effect on what the user will see.
 *
 * A tick SHOWS here, as in the Catalogue visibility card above it. What an
 * admin can get wrong is the empty selection: a manager left with nothing
 * ticked sees almost no clients, silently. So the effect is spelled out in words
 * that change as they toggle, rather than left to a checkbox label. Pure and in
 * `src/lib` so the wording is pinned by a test.
 *
 * `regional` is a REGIONAL_MANAGER, whose ownership arm is "clients owned by a
 * user of my region" (see `companyOwnedWhereForUser`) rather than "mine".
 * `selectedCompanies` is the total across ticked countries and is the number a
 * grant would reveal today.
 */
export function describeContactsAccess(input: {
  allCountries: boolean;
  selectedCountries: number;
  selectedCompanies: number;
  regional: boolean;
}): ContactsAccessSummary {
  const who = input.regional ? "regional manager" : "manager";
  const plus = input.regional ? "the clients owned by their region" : "any they own";

  if (input.allCountries) {
    return {
      tone: "all",
      summary: `This ${who} will see every client in the system, in every country.`,
      warning: null,
    };
  }

  if (input.selectedCountries === 0) {
    const only = input.regional ? "only the clients owned by their region" : "only the clients they own";
    return {
      tone: "none",
      summary: `This ${who} will see ${only}.`,
      warning:
        "Nothing is ticked. Clients imported from ACT! have no owner, so for an imported client base that is close to none. Tick the countries whose clients they should see, or turn on “Show clients from all countries”.",
    };
  }

  const countries = plural(input.selectedCountries, "country", "countries");
  const clients =
    input.selectedCompanies > 0
      ? `the ${plural(input.selectedCompanies, "client", "clients")} in ${countries}`
      : `clients in ${countries} (none have any yet)`;
  return {
    tone: "some",
    summary: `This ${who} will see ${clients}, plus ${plus}.`,
    warning: null,
  };
}

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
