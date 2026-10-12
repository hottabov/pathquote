// The ActOutbox: queueing a quote's write into ACT!.
//
// Three events queue one: finalise (finalizeDocument), the client's signature
// (completeSigning) and the acceptance (acceptQuote). Each queues inside its
// own transaction, through the caller's `tx`, so the event and the intent to
// tell ACT! about it commit together or not at all -- a finalise that
// committed without its row would never reach ACT!, and nothing would say so.
//
// Queueing does not look at the off switch (src/lib/act/write-switch.ts): a
// row is queued whether or not writing is turned on, and the drain decides
// whether to send it. Nothing here calls ACT!.
//
// What a row means, and what the drain does with it, is the outbox planner's
// header in src/lib/act/outbox-plan.ts.
//
// A REQUIREMENT ON THE DRAIN (Task 7): a take-over can land while the drain
// is working the same row. It repoints quoteRevisionId and clears the row's
// progress; a store the drain then makes for the step it planned against the
// OLD revision would mark that step done for the new one. So every store the
// drain makes on the row has to be conditional on the row still carrying the
// revision it planned for.

import type { Prisma } from "@prisma/client";
import { cuid } from "@/lib/cuid";
import { enqueueStatement } from "@/lib/act/outbox-sql";

/** What enqueueActWrite needs of a transaction client. */
type OutboxWriter = Pick<Prisma.TransactionClient, "$executeRaw">;

/** What enqueueActWriteForNewestRevision needs of a transaction client. */
type OutboxRevisionWriter = OutboxWriter & Pick<Prisma.TransactionClient, "quoteRevision">;

/**
 * Queue a write of `quoteRevisionId` for `documentId`: a new row, or the
 * document's unfinished row taken over (enqueueStatement in
 * src/lib/act/outbox-sql.ts says what a take-over resets and keeps). Run it
 * inside the caller's transaction.
 */
export async function enqueueActWrite(
  tx: OutboxWriter,
  input: { documentId: string; quoteRevisionId: string; now: Date },
): Promise<void> {
  await tx.$executeRaw(enqueueStatement({ id: cuid(), ...input }));
}

/**
 * Queue a write of the document's newest revision -- for the client's
 * signature and the acceptance, which happen to a FINAL quote, whose newest
 * revision is the one its last finalise created or kept: the one the client
 * signed. (Document.signedRevisionId is not read: nothing writes it.)
 *
 * Returns false, queueing nothing, for a quote with no revision at all: a
 * quote finalised before revisions existed that the backfill
 * (scripts/backfill-quote-revisions.ts) has not reached. A row has to name a
 * revision, and refusing the signature or the acceptance over ACT! would put
 * the CRM ahead of the quote itself. Such a quote reaches ACT! only if it is
 * finalised again.
 */
export async function enqueueActWriteForNewestRevision(
  tx: OutboxRevisionWriter,
  input: { documentId: string; now: Date },
): Promise<boolean> {
  const newest = await tx.quoteRevision.findFirst({
    where: { documentId: input.documentId },
    orderBy: { revision: "desc" },
    select: { id: true },
  });
  if (!newest) {
    console.warn("[act] no revision to queue for ACT!, nothing queued", { documentId: input.documentId });
    return false;
  }
  await enqueueActWrite(tx, { ...input, quoteRevisionId: newest.id });
  return true;
}
