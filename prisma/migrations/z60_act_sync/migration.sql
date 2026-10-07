-- ACT! read-only sync, phase 1
-- (docs/superpowers/specs/2026-09-08-act-integration-design.md).
--
-- Additive only: new nullable columns and one new enum. No existing row is
-- read or rewritten, so this is safe to run against live data without a
-- backup window.

CREATE TYPE "ActSyncState" AS ENUM ('SYNCED', 'PENDING', 'CONFLICT');

ALTER TABLE "Company"
  ADD COLUMN "actCompanyId"       TEXT,
  ADD COLUMN "actCompanyKey"      TEXT,
  ADD COLUMN "actRecordManagerId" TEXT,
  ADD COLUMN "actStatus"          TEXT,
  ADD COLUMN "actEditedAtSync"    TIMESTAMP(3),
  ADD COLUMN "actSnapshot"        JSONB,
  ADD COLUMN "actSyncedAt"        TIMESTAMP(3);

ALTER TABLE "Contact"
  ADD COLUMN "actContactId"    TEXT,
  ADD COLUMN "actSyncState"    "ActSyncState",
  ADD COLUMN "actEditedAtSync" TIMESTAMP(3),
  ADD COLUMN "actSnapshot"     JSONB,
  ADD COLUMN "actSyncedAt"     TIMESTAMP(3),
  ADD COLUMN "actAccountMgr"   TEXT;

ALTER TABLE "User"
  ADD COLUMN "actUserId"        TEXT,
  ADD COLUMN "actAccountMgr"    TEXT,
  ADD COLUMN "visibleCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Unique rather than plain indexes: each of these IS an identity. Two
-- PathQuote companies claiming the same ACT! company, or the same derived
-- name+country key, is a bug that should fail on insert rather than quietly
-- split a client's quotes across two records.
CREATE UNIQUE INDEX "Company_actCompanyId_key"  ON "Company"("actCompanyId");
CREATE UNIQUE INDEX "Company_actCompanyKey_key" ON "Company"("actCompanyKey");
CREATE UNIQUE INDEX "Contact_actContactId_key"  ON "Contact"("actContactId");
CREATE UNIQUE INDEX "User_actUserId_key"        ON "User"("actUserId");

-- Visibility filters on this once phase 1's data is in place.
CREATE INDEX "Contact_actAccountMgr_idx" ON "Contact"("actAccountMgr");
