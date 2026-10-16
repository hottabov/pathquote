// The zod-free rule for one standard-terms figure, for the builder's panel.
//
// `TermsDocumentsPanel` is a client component and used to validate each field
// as it was typed by reaching into `quoteTermsSchema.shape` -- the right idea
// (one definition of "usable figure") with the wrong cost: it put the zod
// runtime into the builder's JavaScript (PERF-08). The rule is small enough
// to state twice, provided the two statements cannot drift: the limit and the
// three messages are declared here, `termFigureSchema` in quote-documents.ts
// builds itself from them, and tests/quote-terms-client.test.ts holds the two
// to the same verdict and the same words on every kind of input.
//
// Rule: no `zod` import in this file.

/**
 * One ceiling for all four figures rather than a plausible bound per unit
 * (weeks, days, days, months). These are typo guards, not business rules:
 * what a quote may promise for delivery or warranty is a commercial
 * judgement the discount cap has no equivalent of, and the real check is a
 * salesperson reading the sentence back. 999 is high enough that no honest
 * figure ever meets it and low enough that a mistyped year ("2026 weeks")
 * does.
 */
export const TERM_FIGURE_MAX = 999;

export const TERM_FIGURE_MESSAGES = {
  wholeNumber: "Enter a whole number",
  min: "Enter 0 or more",
  max: `Enter ${TERM_FIGURE_MAX} or less`,
} as const;

/**
 * Whether a raw field value means "inherit the region's figure". A cleared
 * input, a missing FormData value and an explicit `null` all do; `0` and
 * `"0"` do NOT -- "Installation: 0 days" is a deliberate promise of none.
 * Tested against the raw value before any coercion, because `Number("")` is
 * `0` and collapsing after coercion would turn every emptied field into a
 * promise of zero.
 */
export function isBlankTermFigure(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

/**
 * The message `termFigureSchema` would give for one raw field value, or
 * `null` when it accepts it (a blank, or a whole number from 0 to 999).
 *
 * The coercion is `Number(raw)`, which is what `z.coerce.number()` does, so
 * `"12"`, `" 12 "` and `"1e2"` are figures and `"12abc"` is not. Checks run
 * in the schema's order -- whole number, then the floor, then the ceiling --
 * and the first failure is the message, which is what the panel shows.
 */
export function termFigureError(raw: unknown): string | null {
  if (isBlankTermFigure(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return TERM_FIGURE_MESSAGES.wholeNumber;
  if (n < 0) return TERM_FIGURE_MESSAGES.min;
  if (n > TERM_FIGURE_MAX) return TERM_FIGURE_MESSAGES.max;
  return null;
}
