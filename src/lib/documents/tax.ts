/**
 * Resolving a document's effective tax — the one decision that says which
 * rate a quote is actually charged at, kept in its own dependency-free
 * module (no `@/lib/db`, no `@prisma/client`) so it can be unit tested the
 * way the rest of the suite is: by importing a pure function and asserting
 * on what it returns, with no mocking and no DATABASE_URL. `recalcDocument`
 * (./recalc.ts) is the only caller; it does the Decimal marshalling either
 * side of this and persists whatever `refresh` comes back.
 *
 * There are two rules here, and they pull in opposite directions.
 *
 * The first is the freeze: an issued quote is a document a customer has in
 * hand, so a FINAL document's tax figures are whatever they were when the
 * number was allocated, and a later admin edit to the region must never
 * retroactively rewrite them. That is the same freeze `entitySnapshot` and
 * the `commission*` columns already give (see `finalizeDocument`,
 * src/lib/actions/finalize.ts) — this simply extends the identical rule to
 * the tax columns, which previously had no explicit rule at all.
 *
 * The second is the refresh, and it is the reason this module exists.
 * `Document.taxName`/`taxRate` are snapshotted from the region the moment a
 * blank draft is created (`createDraft`, src/lib/actions/documents/
 * lifecycle.ts) — before a client, an item or a price exists. Treating that
 * copy as permanent meant a draft created before an admin first configured
 * GST was stuck at 0% for the rest of its life, with the summary quietly
 * showing no tax line and no way whatsoever to correct it short of deleting
 * the draft and starting over. A draft is unissued working material, not a
 * record of anything, so it re-reads its region every time it is
 * recalculated: while a quote is still being built the region's current tax
 * is the truth, and the copy on the row is a cache of it rather than a
 * snapshot of it. The snapshot only becomes real at finalize.
 *
 * `taxName` travels with `taxRate` and is never resolved independently: the
 * label and the number are shown together as "GST 10%", and a document
 * carrying one region's label beside another's rate would be worse than
 * either being stale.
 */

/** The label/rate pair as it is stored on a `Document` or a `Region`. The
 * rate is a string rather than a number because both columns are
 * `Decimal(5,2)` and this module is deliberately Prisma-free — the caller
 * hands over `.toString()` and turns `refresh` back into a `Decimal`. */
export type TaxSnapshot = {
  taxName: string;
  taxRate: string;
};

export type ResolveTaxInput = {
  /** `Document.status`. Anything other than `"DRAFT"` is treated as frozen,
   * so a status added later defaults to the conservative behaviour rather
   * than silently opting itself into the refresh. */
  status: string;
  /** `Document.deliveryTerms` — `"EX_WORKS"` zeroes the rate fed to the
   * engine (see `engineTaxRate` below). */
  deliveryTerms: string;
  /** The figures currently on the document row. */
  document: TaxSnapshot;
  /** The figures currently on the document's region. */
  region: TaxSnapshot;
};

export type ResolvedTax = {
  /** The label the document should carry from here on. */
  taxName: string;
  /** The rate the document should carry from here on, as a string. */
  taxRate: string;
  /** The rate to hand the pricing engine, which is `taxRate` except on an
   * Ex Works quote. Collected at the factory door, an Ex Works supply is not
   * a domestic taxable one, so it is charged no tax — resolved here, the one
   * place a document's effective rate is computed, rather than scattered
   * across every reader of `taxAmount`/`total`. Note that this zero never
   * reaches `taxRate` above: the document goes on carrying its region's
   * nominal rate, and the sheet renders "Ex Works — no GST applicable" from
   * the terms rather than printing a misleading "GST 0%". */
  engineTaxRate: number;
  /** The pair to write back to the document row, or `null` when the row
   * already agrees and the write would be a no-op. Always `null` for a
   * non-DRAFT document — that is what makes the freeze absolute rather than
   * merely usually true. */
  refresh: TaxSnapshot | null;
};

export function resolveDocumentTax(input: ResolveTaxInput): ResolvedTax {
  const frozen = input.status !== "DRAFT";
  const effective = frozen ? input.document : input.region;

  // Compared numerically, not as strings: the same rate reaches here as
  // "10" from one column and "10.00" from another depending on how Prisma
  // rendered the Decimal, and treating those as a difference would make
  // every recalculation of every draft write a pointless update.
  const changed =
    !frozen &&
    (effective.taxName !== input.document.taxName ||
      Number(effective.taxRate) !== Number(input.document.taxRate));

  return {
    taxName: effective.taxName,
    taxRate: effective.taxRate,
    engineTaxRate: input.deliveryTerms === "EX_WORKS" ? 0 : Number(effective.taxRate),
    refresh: changed ? { taxName: effective.taxName, taxRate: effective.taxRate } : null,
  };
}
