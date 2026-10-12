// The SQL the ActOutbox is written with, where Prisma's own calls cannot say
// it. Pure: each function returns a statement, and src/lib/act/outbox.ts runs
// it.

import { Prisma } from "@prisma/client";

export type EnqueueValues = {
  /** The new row's id, used only when the statement inserts (cuid, src/lib/cuid.ts). */
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
 * THE TAKE-OVER, as the outbox planner's header (src/lib/act/outbox-plan.ts)
 * and the migration describe it: the row is pointed at this revision, and
 * what it had stored about its old revision is cleared --
 * opportunityActId and productLineSkippedAt, which say this row's
 * opportunity and line steps are done, and would otherwise mark them done
 * for a revision they were never run for -- along with blockedReason,
 * lastError and attempts, and nextAttemptAt is set to `now`, so the row is
 * due at once and tried afresh. It KEEPS createInFlight: a record a create
 * of the old revision's may have made is in ACT! whatever revision the row
 * carries now (A CREATE IN FLIGHT). It keeps createdAt too, and its id.
 *
 * EVERY TIMESTAMP IS `now`, a parameter, never the database's clock. The
 * columns are timestamp(3) WITHOUT time zone, holding UTC as Prisma writes
 * them. SQL now() and the columns' DEFAULT CURRENT_TIMESTAMP land in them as
 * the session's local time, which this repo does not pin: under
 * Australia/Sydney a row stamped that way reads 10 or 11 hours later than it
 * happened, so it falls due that much late. (Compared the other way, with
 * now() in the drain's WHERE, rows come due that much early; see the
 * migration.) So createdAt is supplied as well, though the worked statement
 * in the migration's comment leaves it to the default. id and updatedAt have
 * no default at all: Prisma fills both in its client.
 */
export function enqueueStatement(values: EnqueueValues): Prisma.Sql {
  const { id, documentId, quoteRevisionId, now } = values;
  return Prisma.sql`
    INSERT INTO "ActOutbox"
      ("id", "documentId", "quoteRevisionId", "nextAttemptAt", "createdAt", "updatedAt")
    VALUES (${id}, ${documentId}, ${quoteRevisionId}, ${now}, ${now}, ${now})
    ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET
      "quoteRevisionId" = EXCLUDED."quoteRevisionId",
      "opportunityActId" = NULL,
      "productLineSkippedAt" = NULL,
      "blockedReason" = NULL,
      "lastError" = NULL,
      "attempts" = 0,
      "nextAttemptAt" = EXCLUDED."nextAttemptAt",
      "updatedAt" = EXCLUDED."updatedAt"`;
}
