// The SQL the ActOutbox is written with, where Prisma's own calls cannot say
// it. Pure: each function returns a statement, and src/lib/act/outbox.ts runs
// it.

import { Prisma } from "@prisma/client";

export type EnqueueValues = {
  /** The new row's id, used only when the statement inserts (a crypto.randomUUID()). */
  id: string;
  documentId: string;
  /** The revision the write is for. */
  quoteRevisionId: string;
  /** When the enqueue happened: the row is due from then. */
  now: Date;
};

/**
 * Queue a write for a document: insert a row, or take over the document's
 * unfinished one.
 *
 * At most one row per document is unfinished (completedAt null), by the
 * partial unique index ActOutbox_documentId_unfinished_key in
 * z65_act_outbox; a blocked row is unfinished too. Prisma's `upsert` cannot
 * name a partial index, so this is an INSERT ... ON CONFLICT, and its
 * conflict target has to repeat the index's predicate: without the
 * `WHERE "completedAt" IS NULL`, Postgres finds no constraint to match and
 * refuses the statement.
 *
 * A new row starts at generation 0.
 *
 * THE TAKE-OVER, as the outbox planner's header (src/lib/act/outbox-plan.ts)
 * and the migration describe it: the row is pointed at this revision, and
 * what it had stored about its old revision is cleared --
 * opportunityActId and productLineSkippedAt, which say this row's
 * opportunity and line steps are done, and would otherwise mark them done
 * for a revision they were never run for -- along with blockedReason,
 * lastError and attempts, and nextAttemptAt is set to `now`, so the row is
 * due at once and tried afresh. generation goes up by 1: that, not the
 * revision, is how a drain already working the row finds out it was taken
 * over, since most take-overs keep the revision (requirement 1 on the drain,
 * in src/lib/act/outbox.ts). It KEEPS createInFlight: a record a create of the
 * old revision's may have made is in ACT! whatever revision the row carries
 * now (A CREATE IN FLIGHT). It keeps createdAt too, and its id.
 *
 * EVERY TIMESTAMP IS `now`, a parameter, never the database's clock. The
 * columns are timestamp(3) WITHOUT time zone, holding UTC as Prisma writes
 * them. SQL now() and the columns' DEFAULT CURRENT_TIMESTAMP land in them as
 * the session's local time, which this repo does not pin: under
 * Australia/Sydney a row stamped that way reads 10 or 11 hours later than it
 * happened, so it falls due that much late. (Compared the other way, with
 * now() in the drain's WHERE, rows come due that much early; see the
 * migration.) So createdAt is supplied as well. id and updatedAt have no
 * default at all: Prisma fills both in its client.
 *
 * The migration's comment quotes this statement; tests/act-outbox-sql.test.ts
 * holds the two together.
 */
export function enqueueStatement(values: EnqueueValues): Prisma.Sql {
  const { id, documentId, quoteRevisionId, now } = values;
  return Prisma.sql`
    INSERT INTO "ActOutbox"
      ("id", "documentId", "quoteRevisionId", "generation", "nextAttemptAt", "createdAt", "updatedAt")
    VALUES (${id}, ${documentId}, ${quoteRevisionId}, 0, ${now}, ${now}, ${now})
    ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET
      "quoteRevisionId" = EXCLUDED."quoteRevisionId",
      "generation" = "ActOutbox"."generation" + 1,
      "opportunityActId" = NULL,
      "productLineSkippedAt" = NULL,
      "blockedReason" = NULL,
      "lastError" = NULL,
      "attempts" = 0,
      "nextAttemptAt" = EXCLUDED."nextAttemptAt",
      "updatedAt" = EXCLUDED."updatedAt"`;
}
