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
