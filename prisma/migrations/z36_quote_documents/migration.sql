-- AlterTable
ALTER TABLE "Region" ADD COLUMN     "deliveryWeeks" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "installationDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "trainingDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "warrantyMonths" INTEGER NOT NULL DEFAULT 12;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "deliveryWeeks" INTEGER,
ADD COLUMN     "installationDays" INTEGER,
ADD COLUMN     "trainingDays" INTEGER,
ADD COLUMN     "warrantyMonths" INTEGER,
ADD COLUMN     "documentsSnapshot" JSONB;

-- CreateTable
CREATE TABLE "QuoteDocument" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "regionId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "includedByDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentExclusion" (
    "documentId" TEXT NOT NULL,
    "quoteDocumentKey" TEXT NOT NULL,

    CONSTRAINT "DocumentExclusion_pkey" PRIMARY KEY ("documentId","quoteDocumentKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoteDocument_key_regionId_key" ON "QuoteDocument"("key", "regionId");

-- CreateIndex
CREATE INDEX "QuoteDocument_regionId_idx" ON "QuoteDocument"("regionId");

-- AddForeignKey
ALTER TABLE "QuoteDocument" ADD CONSTRAINT "QuoteDocument_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentExclusion" ADD CONSTRAINT "DocumentExclusion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
