-- The outbox for writing finalised quotes into ACT!, and the ids it stores.
--
-- Finalising a quote queues one ActOutbox row, or takes over the unfinished
-- one (see ONE UNFINISHED ROW PER DOCUMENT below); the plan's addendum of
-- 2026-10-12 has the client's signature and acceptQuote queue one the same
-- way. A drain then runs that row's steps against ACT! -- create the contact
-- if ACT! does not have it, create or update the deal's opportunity, write
-- the revision's History, and once the quote is signed or accepted, promote
-- the contact to Customer and win the opportunity -- storing each result
-- before the next step, so a row that fails halfway resumes rather than
-- repeating. What comes next is decided by src/lib/act/outbox-plan.ts, whose
-- header lists the stored fields it reads; this migration adds the ones that
-- did not exist:
--
--   Document.actOpportunityId         the deal's opportunity, one per quote
--   Document.actContactPromotedForId  the ACT! contact promote-contact was
--                                     done for: once per contact per deal
--   Document.actOpportunityWonAt      win-opportunity done, once per deal
--   QuoteRevision.actHistoryId        the revision's History, one per
--                                     revision
--   ActOutbox                         the queue itself, with opportunityActId
--                                     for the row's own opportunity step
--
-- Why ACT!'s ids are kept here rather than a PathQuote id stamped into an ACT!
-- custom field is on the ActOutbox model in schema.prisma: the `PQ ` fields
-- need `Define Fields`, which the service account does not have.
--
-- WHAT PRISMA SEES, AND WHAT IT DOES NOT. Everything down to the end of the
-- foreign keys is character for character what `prisma migrate diff
-- --from-schema <main's schema.prisma> --to-schema prisma/schema.prisma
-- --script` prints for these declarations. The two indexes after that are
-- written by hand, because both are PARTIAL (they have a WHERE), and Prisma
-- declares a partial index only under the `partialIndexes` preview feature,
-- which this project does not enable. Without it `migrate diff` leaves partial
-- indexes out of the comparison altogether, so the CI step "Migrations
-- reproduce schema.prisma" (`prisma migrate diff --from-config-datasource
-- --to-schema prisma/schema.prisma --exit-code`) neither expects them nor
-- reports them as drift. That is not a new trick: the two partial uniques on
-- OptionCompatibility have lived in 0_init the same way since the first
-- migration, through every CI run since. Verified for these two by applying
-- every migration to an empty PostgreSQL and running that exact command: "No
-- difference detected", exit 0.
--
-- The cost cuts both ways. The schema file cannot show them, so the ActOutbox
-- model's comment names both. And the drift check cannot see them in EITHER
-- direction: with both dropped from that same migrated database it still says
-- "No difference detected" (tried). Nothing in CI would notice them missing;
-- the rule they enforce is only as safe as this file. Turning on
-- `partialIndexes` would also end the arrangement -- Prisma would then be
-- comparing all four partial indexes, and each would need declaring with
-- `where:` before the check passed again.
--
-- Additive only: no existing row is written. The locks, statement by
-- statement -- `prisma migrate deploy` runs each statement in a transaction
-- of its own, not the file as one (tried with Prisma 7.10: a migration whose
-- second statement fails leaves the first applied, and txid_current()
-- differs from statement to statement), so each lock is released when its
-- statement ends:
--   - ADD COLUMN takes ACCESS EXCLUSIVE on Document (one statement for its
--     three columns) and on QuoteRevision. The columns are nullable with no
--     default, so it changes the catalog only and rewrites nothing, but while
--     it waits for the lock every later query on that table queues behind it.
--   - The two unique indexes, on Document.actOpportunityId and
--     QuoteRevision.actHistoryId, take SHARE on those tables (writes wait,
--     reads do not) and read every row to build, though every value is NULL.
--   - The two foreign keys take SHARE ROW EXCLUSIVE on Document and
--     QuoteRevision, the referenced tables, and validate against ActOutbox,
--     which is empty.
-- Brief on tables the size of these. The flip side of no single transaction:
-- a statement that fails leaves the ones before it applied, and the
-- migration recorded as failed for `prisma migrate resolve`.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "actContactPromotedForId" TEXT,
ADD COLUMN     "actOpportunityId" TEXT,
ADD COLUMN     "actOpportunityWonAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QuoteRevision" ADD COLUMN     "actHistoryId" TEXT;

-- CreateTable
CREATE TABLE "ActOutbox" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "quoteRevisionId" TEXT NOT NULL,
    "opportunityActId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActOutbox_documentId_idx" ON "ActOutbox"("documentId");

-- CreateIndex
CREATE INDEX "ActOutbox_quoteRevisionId_idx" ON "ActOutbox"("quoteRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_actOpportunityId_key" ON "Document"("actOpportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRevision_actHistoryId_key" ON "QuoteRevision"("actHistoryId");

-- AddForeignKey
ALTER TABLE "ActOutbox" ADD CONSTRAINT "ActOutbox_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActOutbox" ADD CONSTRAINT "ActOutbox_quoteRevisionId_fkey" FOREIGN KEY ("quoteRevisionId") REFERENCES "QuoteRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ONE UNFINISHED ROW PER DOCUMENT. A repeated click on Finalise, or an
-- unfinalise and re-finalise that changed nothing, must not queue a second
-- write for a quote while the first is still pending: two live rows for one
-- deal could each write the same revision's History. (Two rows drained at
-- once could also both find Document.actOpportunityId empty and both create
-- an opportunity, but the drain's advisory lock, Task 7, is to rule that out
-- on its own.) A plain unique on documentId would be wrong: a document
-- collects FINISHED rows over its life, up to one per enqueue, and those
-- must coexist.
--
-- "Unfinished" is "completedAt IS NULL", and nothing else -- a BLOCKED row
-- (blockedReason set) is unfinished too, and holds the slot. So an enqueue -- a
-- re-finalise, or a signature or acceptance -- that finds an unfinished row,
-- pending or blocked, does not insert: it takes that row over, pointing it at
-- the revision the enqueue is for, clearing blockedReason, opportunityActId and
-- lastError, and resetting attempts. That is how "unfinalize, choose a contact,
-- finalize again" un-blocks a quote that had no contact. Leaving blocked rows
-- out of this predicate instead was considered and rejected: a stale blocked
-- row would sit beside its replacement forever, and anything that later cleared
-- its blockedReason -- the fix for a nameless contact or an unmapped region
-- needs no re-finalise -- would put two live rows on one deal.
--
-- An enqueue can name this index as its conflict target, every value a
-- parameter ($4 is the JS Date of the enqueue; see the drain's query below
-- for why not now()):
--   INSERT INTO "ActOutbox"
--     ("id", "documentId", "quoteRevisionId", "nextAttemptAt", "updatedAt")
--   VALUES ($1, $2, $3, $4, $4)
--   ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET
--     "quoteRevisionId" = EXCLUDED."quoteRevisionId", "opportunityActId" = NULL,
--     "blockedReason" = NULL, "attempts" = 0, "lastError" = NULL,
--     "nextAttemptAt" = $4, "updatedAt" = $4
-- "id" and "updatedAt" have no database default (Prisma fills both in the
-- client), so a raw insert must supply them; and Prisma's `upsert` cannot
-- target a partial index, so Task 6 issues this with $executeRaw.
CREATE UNIQUE INDEX "ActOutbox_documentId_unfinished_key" ON "ActOutbox"("documentId") WHERE "completedAt" IS NULL;

-- The drain's query: unfinished, not blocked, due, longest overdue first --
--   WHERE "completedAt" IS NULL AND "blockedReason" IS NULL
--     AND "nextAttemptAt" <= $1 ORDER BY "nextAttemptAt"
-- $1 is a JS Date, passed as a parameter, never SQL now(). nextAttemptAt is
-- timestamp(3) WITHOUT time zone, and Prisma fills it with UTC; now() is
-- compared with it in the session's zone, which this repo does not pin. Under
-- Australia/Sydney a row due in an hour already passes "<= now()" (tried:
-- rows come due 10 or 11 hours early, with daylight saving), while Prisma
-- sends a Date as UTC and compares correctly (tried, same zone). Likewise
-- the column's DEFAULT CURRENT_TIMESTAMP is the session's local time, so a
-- raw INSERT supplies nextAttemptAt itself.
-- This index holds every unfinished, unblocked row, in nextAttemptAt order, so
-- "due" is a range scan from its start and needs no sort (EXPLAIN on the
-- migrated database: Index Scan using "ActOutbox_due_idx", no Sort node).
-- Finished rows pile up, up to one per enqueue, for as long as the table
-- exists, and neither they nor blocked rows are in here, so the index stays
-- the size of the queue. Blocked rows are NOT simply waiting for a person:
-- fixing what a blocked reason asks (naming the contact, mapping the region)
-- involves no re-finalise, so nothing takes the row over and nothing makes it
-- due. The drain must re-plan every blocked row on each pass, outside this
-- index, and clear blockedReason once the planner no longer blocks it.
CREATE INDEX "ActOutbox_due_idx" ON "ActOutbox"("nextAttemptAt") WHERE "completedAt" IS NULL AND "blockedReason" IS NULL;
