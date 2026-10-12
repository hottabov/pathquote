-- The outbox for writing finalised quotes into ACT!, and the ids it stores.
--
-- Finalising a quote queues one ActOutbox row for the revision it finalised.
-- A drain then runs that row's steps against ACT! -- create the contact if ACT!
-- does not have it, create or update the deal's opportunity, write the
-- revision's History -- storing each result before the next step, so a row
-- that fails halfway resumes rather than repeating. What comes next is decided
-- by src/lib/act/outbox-plan.ts, whose header lists the stored fields it reads;
-- this migration adds the ones that did not exist:
--
--   Document.actOpportunityId     the deal's opportunity, one per quote
--   QuoteRevision.actHistoryId    the revision's History, one per revision
--   ActOutbox                     the queue itself, with opportunityActId for
--                                 the row's own opportunity step
--
-- Why ACT!'s ids are kept here rather than a PathQuote id stamped into an ACT!
-- custom field is on the ActOutbox model in schema.prisma: the `PQ ` fields
-- need `Define Fields`, which the service account does not have.
--
-- WHAT PRISMA SEES, AND WHAT IT DOES NOT. Everything down to the end of the
-- foreign keys is character for character what
-- `prisma migrate diff --from-schema <before> --to-schema <after> --script`
-- prints for the declarations in prisma/schema.prisma. The two indexes after
-- that are written by hand, because both are PARTIAL (they have a WHERE), and
-- Prisma declares a partial index only under the `partialIndexes` preview
-- feature, which this project does not enable. Without it `migrate diff`
-- leaves partial indexes out of the comparison altogether, so the CI step
-- "Migrations reproduce schema.prisma" (`prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema.prisma --exit-code`)
-- neither expects them nor reports them as drift. That is not a new trick: the
-- two partial uniques on OptionCompatibility have lived in 0_init the same way
-- since the first migration, through every CI run since. Verified for these two
-- by applying every migration to an empty PostgreSQL and running that exact
-- command: "No difference detected", exit 0.
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
-- Additive only. Two nullable columns with no default (no table rewrite), one
-- new table, and indexes on a table that starts empty -- apart from the two
-- unique indexes on the new columns, which are built over Document and
-- QuoteRevision while every value is NULL, and hold a SHARE lock on each for
-- the moment that takes. No existing row is read or written.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "actOpportunityId" TEXT;

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

-- ONE UNFINISHED ROW PER DOCUMENT. Re-finalising must not queue a second write
-- for a quote while the first is still pending, or two drains could both find
-- Document.actOpportunityId empty and both create an opportunity for the one
-- deal. A plain unique on documentId would be wrong: a document collects one
-- FINISHED row per finalise over its life, and those must coexist.
--
-- "Unfinished" is "completedAt IS NULL", and nothing else -- a BLOCKED row
-- (blockedReason set) is unfinished too, and holds the slot. So a re-finalise
-- that finds an unfinished row, pending or blocked, does not insert: it takes
-- that row over, pointing it at the new revision and clearing blockedReason
-- and opportunityActId. That is how "unfinalize, choose a contact, finalize
-- again" un-blocks a quote that had no contact. Leaving blocked rows out of
-- this predicate instead was considered and rejected: a stale blocked row
-- would sit beside its replacement forever, and anything that later cleared
-- its blockedReason -- the fix for a nameless contact or an unmapped region
-- needs no re-finalise -- would put two live rows on one deal.
--
-- An enqueue can name this index as its conflict target:
--   INSERT INTO "ActOutbox" (...) VALUES (...)
--   ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET ...
CREATE UNIQUE INDEX "ActOutbox_documentId_unfinished_key" ON "ActOutbox"("documentId") WHERE "completedAt" IS NULL;

-- The drain's query: unfinished, not blocked, due, longest overdue first --
--   WHERE "completedAt" IS NULL AND "blockedReason" IS NULL
--     AND "nextAttemptAt" <= now() ORDER BY "nextAttemptAt"
-- This index holds every unfinished, unblocked row, in nextAttemptAt order, so
-- "due" is a range scan from its start and needs no sort (EXPLAIN on the
-- migrated database: Index Scan using "ActOutbox_due_idx", no Sort node).
-- Finished rows pile up at one per finalise for as long as the table exists;
-- blocked ones wait for a person. Neither is in here, so the index stays the
-- size of the queue.
CREATE INDEX "ActOutbox_due_idx" ON "ActOutbox"("nextAttemptAt") WHERE "completedAt" IS NULL AND "blockedReason" IS NULL;
