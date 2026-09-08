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

/** A whole number of days from 1 to `max` inclusive (default 365), coerced
 * from the string a `FormData` field always yields. The default upper bound
 * is a year rather than the 30-day norm because a customer's capex approval
 * can genuinely take six weeks; the UI warns above 30 rather than blocking.
 * `max` exists so a caller whose question isn't "how long should this
 * document stay valid" — see `signingLinkValidityDaysSchema`,
 * src/lib/validation/settings.ts, which caps a signing link's *exposure
 * window* at 90 rather than reusing this 365-day *validity* ceiling — can
 * override it without forking the whole builder. */
export function validityDayCountSchema(messages: ValidityDaysMessages = {}, max = 365) {
  return z.coerce
    .number({ error: messages.invalidType })
    .int(messages.notInteger)
    .min(1, messages.tooSmall)
    .max(max, messages.tooLarge);
}
