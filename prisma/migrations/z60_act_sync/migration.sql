-- ACT! read-only sync, phase 1
-- (docs/superpowers/specs/2026-09-08-act-integration-design.md).
--
-- Additive only: new nullable columns and one new enum. No data is modified --
-- there is no backfill, no UPDATE and no drop. The index builds do scan every
-- row and take a brief write lock on Company and Contact. Whether that needs a
-- backup window is the approver's call, not this file's.

CREATE TYPE "ActSyncState" AS ENUM ('SYNCED', 'PENDING', 'CONFLICT');

ALTER TABLE "Company"
  ADD COLUMN "actCompanyId"       TEXT,
  ADD COLUMN "actCompanyKey"      TEXT,
  ADD COLUMN "actRecordManagerId" TEXT,
  ADD COLUMN "actStatus"          TEXT,
  ADD COLUMN "actSyncedAt"        TIMESTAMP(3);

ALTER TABLE "Contact"
  ADD COLUMN "actContactId"      TEXT,
  ADD COLUMN "actSyncState"      "ActSyncState",
  ADD COLUMN "actSourceEditedAt" TIMESTAMP(3),
  ADD COLUMN "actSyncedAt"       TIMESTAMP(3),
  ADD COLUMN "actAccountMgr"     TEXT;

ALTER TABLE "User"
  ADD COLUMN "actUserId"        TEXT,
  ADD COLUMN "actAccountMgr"    TEXT,
  -- No NOT NULL: this is what `prisma migrate diff` generates for a
  -- `String[] @default([])`, and CI compares the two.
  ADD COLUMN "visibleCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Unique rather than plain indexes: each of these IS an identity. Two
-- PathQuote companies claiming the same ACT! company, or the same derived
-- name+country key, is a bug that should fail on insert rather than quietly
-- split a client's quotes across two records.
CREATE UNIQUE INDEX "Company_actCompanyId_key"  ON "Company"("actCompanyId");
CREATE UNIQUE INDEX "Company_actCompanyKey_key" ON "Company"("actCompanyKey");
CREATE UNIQUE INDEX "Contact_actContactId_key"  ON "Contact"("actContactId");
CREATE UNIQUE INDEX "User_actUserId_key"        ON "User"("actUserId");

-- The ACT! payload sits in its own table so it is never selected alongside a
-- company name. One row per contact or company, never both, which Prisma
-- cannot express and a CHECK can.
CREATE TABLE "ActSnapshot" (
  "id"        TEXT  NOT NULL,
  "contactId" TEXT,
  "companyId" TEXT,
  "payload"   JSONB NOT NULL,

  CONSTRAINT "ActSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActSnapshot_one_owner" CHECK (
    ("contactId" IS NOT NULL) <> ("companyId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ActSnapshot_contactId_key" ON "ActSnapshot"("contactId");
CREATE UNIQUE INDEX "ActSnapshot_companyId_key" ON "ActSnapshot"("companyId");

ALTER TABLE "ActSnapshot"
  ADD CONSTRAINT "ActSnapshot_contactId_fkey" FOREIGN KEY ("contactId")
    REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ActSnapshot_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
