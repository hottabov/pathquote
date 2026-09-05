// The one definition of "how many days a quote stays valid". Two schemas
// used to spell the same rule out independently — `quoteValidityDaysSchema`
// (the org-wide default, src/lib/validation/settings.ts) and
// `validityDaysSchema` (the per-document override,
// src/lib/validation/documents.ts) — which meant the 1..365 bounds had to be
// changed in two places to stay a single business rule.
//
// They are not collapsed into one schema, because the two differ in ways
// that are visible to the person filling in the form: the settings field is
// mandatory and phrases its own errors ("Quote validity must be at least 1
// day"), while the per-document field accepts blank as "inherit the org
// setting" and leaves zod's default wording in place. Only the rule itself
// is shared; each caller keeps its own nullability and its own copy.
import { z } from "zod";

/** Error copy overrides. Every field is optional: omitting one leaves zod's
 * default message, which is exactly what the per-document override wants. */
export type ValidityDaysMessages = {
  /** Input that cannot be coerced to a number at all. */
  invalidType?: string;
  notInteger?: string;
  tooSmall?: string;
  tooLarge?: string;
};

/** A whole number of days from 1 to 365 inclusive, coerced from the string a
 * `FormData` field always yields. The upper bound is a year rather than the
 * 30-day norm because a customer's capex approval can genuinely take six
 * weeks; the UI warns above 30 rather than blocking. */
export function validityDayCountSchema(messages: ValidityDaysMessages = {}) {
  return z.coerce
    .number({ error: messages.invalidType })
    .int(messages.notInteger)
    .min(1, messages.tooSmall)
    .max(365, messages.tooLarge);
}
