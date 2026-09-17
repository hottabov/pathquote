/**
 * The pure decisions behind quote revisions: what a revision is labelled, and
 * whether a given finalize should mint a new one at all. Kept free of
 * `@/lib/db` and Prisma types so it is unit-testable without a database (same
 * reasoning as src/lib/signing/state.ts) — `finalizeDocument` is the thin
 * wrapper that reads the last revision and writes the new one.
 */

/**
 * The printed label for a revision. Revision 0 is the bare quote number
 * (e.g. `Q-AU-2026-001`); every later revision suffixes `-R<n>`
 * (`-R1`, `-R2`, …). A quote with no allocated number yet has no label —
 * numbering happens at finalize, before this is ever called, so in practice
 * `number` is always present, but the signature stays honest about the null.
 */
export function revisionLabel(quoteNumber: string | null, revision: number): string | null {
  if (!quoteNumber) return null;
  return revision === 0 ? quoteNumber : `${quoteNumber}-R${revision}`;
}

export interface RevisionPlan {
  /** Whether finalize should create a new QuoteRevision row. False only when
   * the content is byte-for-byte what the last revision already froze. */
  create: boolean;
  /** The revision number the quote should carry after this finalize —
   * the new one when `create`, or the unchanged last one when not. */
  revision: number;
}

/**
 * Decides what a finalize does to the revision counter, given the latest
 * revision already on file and the hash of the freshly-built snapshot.
 *
 * - No prior revision at all → revision 0, create it (first finalize).
 * - New hash equals the last revision's hash → the manager unfinalized and
 *   re-finalized without changing anything; keep the number, create nothing.
 *   This is the guard that stops a stray unfinalize/finalize click from
 *   marching the -R suffix forward (spec §5).
 * - Otherwise → last + 1, create it.
 */
export function planRevision(input: {
  lastRevision: number | null;
  lastSnapshotHash: string | null;
  newSnapshotHash: string;
}): RevisionPlan {
  if (input.lastRevision === null || input.lastSnapshotHash === null) {
    return { create: true, revision: 0 };
  }
  if (input.newSnapshotHash === input.lastSnapshotHash) {
    return { create: false, revision: input.lastRevision };
  }
  return { create: true, revision: input.lastRevision + 1 };
}
