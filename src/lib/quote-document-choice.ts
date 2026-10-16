// Which legal documents a quote prints. Pure: no `@/lib/db`, so the rule is
// testable without a database and shared by every place that answers the
// question -- the builder panel, the readiness check, the renderer,
// finalize, and the revision backfill. While each of them spelled out
// `includedByDefault && !excluded` on its own, a document set to "not
// included by default" could never reach a quote, whatever its author ticked.

/** A quote's own decisions, by document key (`QuoteDocumentChoice` rows):
 * `true` asks for a document, `false` leaves one out. A key with no entry
 * follows the document's `includedByDefault`. */
export type QuoteDocumentChoices = Readonly<Record<string, boolean>>;

/** Whether a quote with these choices prints this document. */
export function isQuoteDocumentIncluded(
  row: { key: string; includedByDefault: boolean },
  choices: QuoteDocumentChoices
): boolean {
  return Object.hasOwn(choices, row.key) ? choices[row.key] : row.includedByDefault;
}

/** `QuoteDocumentChoice` rows as `QuoteDocumentChoices`. */
export function toQuoteDocumentChoices(
  rows: ReadonlyArray<{ quoteDocumentKey: string; included: boolean }>
): QuoteDocumentChoices {
  return Object.fromEntries(rows.map((row) => [row.quoteDocumentKey, row.included]));
}

/**
 * The choices after an author ticks (`include: true`) or unticks a document.
 * A tick that lands back on the document's default drops the entry rather
 * than storing it, so the quote follows the default again -- and goes on
 * following it if an admin later changes that default.
 */
export function withQuoteDocumentChoice(
  choices: QuoteDocumentChoices,
  row: { key: string; includedByDefault: boolean },
  include: boolean
): QuoteDocumentChoices {
  const next: Record<string, boolean> = { ...choices };
  if (include === row.includedByDefault) delete next[row.key];
  else next[row.key] = include;
  return next;
}
