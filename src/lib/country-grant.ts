// Pure parsing of a `User.visibleCountries` grant, for
// scripts/set-user-countries.ts. Lives in src/lib rather than the script so
// the rules are unit-testable without a database. No `@/lib/db` or `next/*`
// imports.
import { normalizeCountryInput } from "./countries";
import { ALL_COUNTRIES } from "./scope";

/** The argument that clears a grant. Spelled out because an empty string is
 * what an unset shell variable expands to, and that must not quietly revoke
 * (or, worse, be mistaken for "all") anyone's access. */
export const NO_COUNTRIES = "none";

export type CountryGrantResult =
  | { ok: true; countries: string[] }
  | { ok: false; error: string };

/**
 * Turns the script's comma-separated argument into the array to store.
 *
 * - `US,CA` -> `["CA", "US"]`: upper-cased, de-duplicated, sorted, so the same
 *   grant is always stored the same way and a before/after diff is readable.
 * - `*` -> `["*"]`, every country. It must stand alone: `US,*` is a typo or a
 *   misunderstanding, and storing it either way would hide which.
 * - `none` -> `[]`, no country grant.
 * - Every other entry must be recognised by `normalizeCountryInput`, which
 *   also maps a few spellings (`UK` -> `GB`); a code it does not know is an
 *   error naming that code, never stored. An empty entry (`US,,CA`) is an
 *   error too, and so is an empty argument.
 */
export function parseCountryGrant(input: string): CountryGrantResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: `no countries given. Pass a comma-separated list, "${ALL_COUNTRIES}" for every country, or "${NO_COUNTRIES}" to clear the grant.`,
    };
  }
  if (trimmed.toLowerCase() === NO_COUNTRIES) return { ok: true, countries: [] };

  const entries = trimmed.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) {
    return { ok: false, error: `"${input}" has an empty entry. Check for a stray comma.` };
  }

  if (entries.includes(ALL_COUNTRIES)) {
    if (entries.length > 1) {
      return {
        ok: false,
        error: `"${ALL_COUNTRIES}" means every country and must be the only entry, got "${input}".`,
      };
    }
    return { ok: true, countries: [ALL_COUNTRIES] };
  }

  return resolveCountryCodes(entries);
}

/**
 * The rules for a list of individual country entries, shared by the script
 * (via `parseCountryGrant`) and the admin editor's action (via
 * `grantFromSelection`) so the two cannot drift apart: each entry must be
 * recognised by `normalizeCountryInput`, which also maps a few spellings
 * (`UK` -> `GB`); the result is upper-cased, de-duplicated and sorted; and an
 * entry it does not know is an error naming it, never silently dropped. An
 * empty entry is unknown too. Does not handle `"*"` or `"none"` -- those are
 * the callers' own vocabulary (a word on the command line, a switch in the
 * editor), and a `"*"` reaching here is reported as an unknown country.
 */
export function resolveCountryCodes(entries: readonly string[]): CountryGrantResult {
  const unknown: string[] = [];
  const codes = new Set<string>();
  for (const entry of entries) {
    const code = normalizeCountryInput(entry);
    if (code === null) unknown.push(entry);
    else codes.add(code);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `not a known country: ${unknown.map((u) => `"${u}"`).join(", ")}. Use ISO 3166-1 alpha-2 codes such as US, CA, GB.`,
    };
  }
  return { ok: true, countries: [...codes].sort() };
}

/**
 * The array to store for the editor's state: an "all countries" switch and a
 * list of ticked codes.
 *
 * - `allCountries` -> `["*"]`, and `codes` is ignored, however long: with the
 *   switch on the list is inert in the editor, so whatever it holds is
 *   leftover state, not a request.
 * - otherwise `codes` goes through `resolveCountryCodes`. An empty list is a
 *   valid result (`[]`, no grant) -- the editor shows the admin what that
 *   means before they save it.
 */
export function grantFromSelection(
  allCountries: boolean,
  codes: readonly string[]
): CountryGrantResult {
  if (allCountries) return { ok: true, countries: [ALL_COUNTRIES] };
  return resolveCountryCodes(codes);
}
