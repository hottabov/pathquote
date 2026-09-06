-- Catalogue import (Settings -> Import / Export): the audit table, and the
-- one schema decision the import depends on, written down.
--
-- DocumentItem.product now declares `onDelete: SetNull` explicitly in
-- prisma/schema.prisma. That is what Prisma's default for an optional
-- relation already was, so this migration carries NO statement for it --
-- `prisma migrate diff` from the previous schema to this one produces
-- exactly the SQL below and nothing for DocumentItem (verified 2026-09-06).
-- The point is the schema comment: a finalized quote must survive its
-- product being deleted (its items are snapshots), and the catalogue import
-- is what takes care of drafts, deleting their items and lines itself and
-- recalculating each one before the product row goes. See
-- docs/plans/2026-09-05-catalog-import-export.md §1.
--
-- CatalogImport records every *confirmed* import: who, when, which file,
-- the per-sheet/per-bucket counts, and the full preview diff the admin saw
-- (plan §3.5). A preview writes nothing and is not recorded. FAILED rows
-- keep the diff that was attempted and the error that rolled it back, so a
-- bad import can be reconstructed either way. `counts` is a copy of
-- `diff.counts` so the history list never has to load the diff column.
--
-- The user FK is ON DELETE RESTRICT (Prisma's default for a required
-- relation): the app deactivates users rather than deleting them, and an
-- audit row must not disappear with its author.

-- CreateEnum
CREATE TYPE "CatalogImportStatus" AS ENUM ('APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "CatalogImport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "status" "CatalogImportStatus" NOT NULL,
    "error" TEXT,

    CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogImport_createdAt_idx" ON "CatalogImport"("createdAt");

-- AddForeignKey
ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
