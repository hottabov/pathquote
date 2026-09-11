-- One-off repair for a database that was migrated BEFORE commit a2cbd25.
--
-- WHAT WENT WRONG
--
-- a2cbd25 ("don't let a years-old quote block deleting a contact") edited
-- prisma/migrations/z35_quote_signing/migration.sql in place instead of adding
-- a new migration. Editing an applied migration changes nothing in a database
-- that already ran it, so every database migrated before that commit still has
-- the pre-a2cbd25 shape of "SigningRequest":
--
--   * no "declineUserAgent" column -- which schema.prisma declares, so the
--     generated client puts it in the SELECT list of every SigningRequest read
--     and Postgres rejects the whole query;
--   * "contactId" NOT NULL with an ON DELETE RESTRICT foreign key -- the exact
--     thing a2cbd25 set out to fix, so deleting a contact who was ever sent a
--     quote still fails with a raw foreign-key error.
--
-- Prisma sees both halves of the damage and refuses to go further: the file's
-- checksum no longer matches the one recorded when it ran ("modified after it
-- was applied"), and the live schema no longer matches what the migration
-- files describe ("drift detected"). Its only offer is `migrate reset`, which
-- drops every row in the database.
--
-- WHAT THIS DOES INSTEAD
--
-- Applies by hand exactly what the edited z35 would have applied, then
-- re-records z35's checksum so Prisma stops calling the file modified. After
-- this the database matches the migration history again and `prisma migrate
-- dev` proceeds normally.
--
-- Every statement is idempotent, so running it against a database that is
-- already correct -- one created from the migration files after a2cbd25 -- is
-- a no-op rather than an error.
--
--   npx prisma db execute --file scripts/repair-z35-signing-request-drift.sql
--   npx prisma migrate status
--
-- NOT a migration, and deliberately not in prisma/migrations/: it rewrites a
-- row in _prisma_migrations, which is Prisma's own bookkeeping and not
-- something a migration may touch. Delete this file once every database that
-- matters has been through it.

-- The column schema.prisma has declared since a2cbd25.
ALTER TABLE "SigningRequest" ADD COLUMN IF NOT EXISTS "declineUserAgent" TEXT;

-- A contact who was sent a quote years ago must stay deletable: the request
-- keeps its own `email` snapshot, so losing the link costs no audit trail.
ALTER TABLE "SigningRequest" ALTER COLUMN "contactId" DROP NOT NULL;

ALTER TABLE "SigningRequest" DROP CONSTRAINT IF EXISTS "SigningRequest_contactId_fkey";
ALTER TABLE "SigningRequest" ADD CONSTRAINT "SigningRequest_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- SHA-256 of prisma/migrations/z35_quote_signing/migration.sql as it stands in
-- the repository today. Recompute it (shasum -a 256 <that file>) and update
-- this literal if the file is ever legitimately regenerated -- a stale value
-- here brings the "modified after it was applied" error straight back.
UPDATE "_prisma_migrations"
SET "checksum" = '1c7399dcb5069e662535893e049178f30c9df383077678ed14502895016300eb'
WHERE "migration_name" = 'z35_quote_signing';
