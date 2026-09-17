-- Revisions, unfinalize-for-managers, signature split and the client send
-- dialog (spec: docs/specs/pathquote-revisions-send-spec.md). This is pure
-- DDL: it adds the new columns and tables only. Backfilling revision 0 for
-- quotes that were already FINAL before this migration needs application code
-- to build each snapshot (buildRevisionSnapshot reads the region, the
-- quote-document bodies and the item/line rows), so it runs as a separate,
-- reviewable step (scripts/backfill-quote-revisions.ts) rather than as SQL
-- that would have to reimplement the projection.
--
-- NOTE for the maintainer running this locally: this SQL was hand-authored to
-- match schema.prisma. Regenerate/validate it with
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script
-- (or `prisma migrate dev`) before applying, since `prisma generate`/migrate
-- cannot run in the sandbox this was written in.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "revision" INTEGER,
ADD COLUMN     "finalizedAt" TIMESTAMP(3),
ADD COLUMN     "finalizedById" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "hasUnsentChanges" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signedRevisionId" TEXT,
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedById" TEXT;

-- CreateTable
CREATE TABLE "QuoteRevision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "pdfPath" TEXT,
    "signedPdfPath" TEXT,
    "total" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "QuoteRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteEvent" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteEmail" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentById" TEXT NOT NULL,
    "providerId" TEXT,

    CONSTRAINT "QuoteEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRevision_documentId_revision_key" ON "QuoteRevision"("documentId", "revision");

-- CreateIndex
CREATE INDEX "QuoteRevision_documentId_idx" ON "QuoteRevision"("documentId");

-- CreateIndex
CREATE INDEX "QuoteEvent_documentId_idx" ON "QuoteEvent"("documentId");

-- CreateIndex
CREATE INDEX "QuoteEmail_documentId_idx" ON "QuoteEmail"("documentId");

-- AddForeignKey
ALTER TABLE "QuoteRevision" ADD CONSTRAINT "QuoteRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteEvent" ADD CONSTRAINT "QuoteEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteEmail" ADD CONSTRAINT "QuoteEmail_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
