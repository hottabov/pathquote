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
// REQUIREMENTS ON THE DRAIN, which follow from how the enqueue works. The
// drain is drainActOutbox in src/lib/act/drain.ts, which marks where it meets
// each one.
//
// 1. A TAKE-OVER CAN LAND WHILE THE DRAIN WORKS THE ROW, and the guard is
//    ActOutbox.generation, not the revision. A take-over clears the row's
//    progress, resets attempts and makes it due -- and most take-overs keep
//    the revision: a signature or an acceptance landing on the finalise's
//    unfinished row, or a re-finalise that changed nothing. Say the drain
//    plans write-product-line for a Won deal while the quote is unsigned,
//    and productLineWrite says `skip`; the client signs, and the take-over
//    clears productLineSkippedAt so that the signed figure goes in; a store
//    of productLineSkippedAt conditioned on the revision would still match,
//    put the skip back, and the Won deal would never show the signed figure.
//    A failure's store of attempts and nextAttemptAt would likewise undo the
//    take-over's reset. Every take-over adds 1 to generation
//    (enqueueStatement in src/lib/act/outbox-sql.ts). So the drain reads
//    generation with the row, and makes every store on the row --
//    opportunityActId, productLineSkippedAt, attempts, lastError,
//    nextAttemptAt, blockedReason, completedAt, and SETTING createInFlight --
//    with
//      WHERE "id" = <the row> AND "generation" = <as read>
//        AND "completedAt" IS NULL
//    and treats no row updated as "taken over": it drops what it planned and
//    reads the row again. Setting createInFlight is guarded like the rest,
//    and no row updated means the POST is not sent.
//    The one store on the row NOT guarded by generation is CLEARING
//    createInFlight, in the transaction that stores the created record's id
//    (WHERE "id" = <the row> AND "completedAt" IS NULL): a take-over keeps the
//    marker, so it is still the one this drain set, and a "contact" marker
//    left behind would block the row for a person over a contact whose id is
//    stored.
//    Nor are stores elsewhere guarded or rolled back over it -- Contact,
//    Document and QuoteRevision: each records what ACT! now holds (an id it
//    minted, the revision the line shows, a promotion or a win made), which
//    stays true whatever the row now carries; and a lost id would have the
//    next pass create its record a second time.
//
// 2. THE OFF SWITCH IS READ BEFORE EACH ACT! CALL, not once per pass: the
//    Setting row, through actWriteEnabled (src/lib/act/write-switch.ts),
//    immediately before each call the drain makes into ActClient. A pass can
//    run for minutes over a backlog; read once, the switch would let the rest
//    of that pass go on writing after it was turned off, and write-switch.ts
//    promises it can be turned off the moment a write goes wrong.
//
// 3. NO LOCK ON AN ActOutbox ROW IS HELD ACROSS AN ACT! CALL: no SELECT ...
//    FOR UPDATE, and no transaction that has written the row, left open
//    while ACT! answers. Finalise, the signature and the acceptance each
//    update the Document and then run the enqueue, whose ON CONFLICT ... DO
//    UPDATE waits on the row's lock -- holding the Document's lock, inside a
//    Prisma interactive transaction that gives up after its timeout (5 s by
//    default). A slow ACT! would then fail a finalise, or a client's
//    signature. The stores are short transactions made after ACT! answers;
//    keeping two drains apart is the drain's advisory lock's job (see
//    z65_act_outbox), not a row lock's.
//
// 4. THE DOCUMENT FIRST. A drain transaction that writes both the Document
//    and the row updates the Document first and the row second -- the
//    enqueue's own order (3) -- or it can deadlock against an enqueue, each
//    holding the lock the other waits for, and Postgres aborts one of the
//    two: possibly the finalise.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
  // A UUID, not Prisma's cuid(): @default(cuid()) is filled in by Prisma's
  // client, which a raw INSERT bypasses, and nothing reads the id's shape.
  await tx.$executeRaw(enqueueStatement({ id: randomUUID(), ...input }));
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
