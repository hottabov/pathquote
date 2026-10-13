-- Per-user control over the quote builder's "Your commission" line.
--
-- The figure is the salesperson commission Pathfinder pays its own staff,
-- worked out from the commission-tier table in Settings -> Preferences.
-- Distributors will quote their own clients in PathQuote; how they pay their
-- own people is theirs to decide, so Pathfinder's staff commission is a wrong
-- number for them and a look inside Pathfinder's pay. An admin now decides per
-- user, and `User.commissionVisible` is where that decision is stored -- see
-- `canSeeCommission` in src/lib/roles.ts. An ADMIN or DEVELOPER sees it by role
-- and this column is never consulted for them.
--
-- DEFAULT false, backfill true -- the same pair z64_act_sync_visible chose, for
-- the same reason: a new distributor is hidden without anybody having to
-- remember to untick anything, and nothing changes for anyone already using
-- the system (as of this migration, the company's own staff only).
--
-- The ADD COLUMN is what `prisma migrate diff` prints for the
-- `commissionVisible Boolean @default(false)` declaration in
-- prisma/schema.prisma; the UPDATE writes data, not structure, so the
-- "Migrations reproduce schema.prisma" check does not see it.
--
-- Additive. No existing value is overwritten: the column does not exist before
-- this runs. Applied once -- `_prisma_migrations` records it -- which is why the
-- backfill lives here and not in a script someone could run twice and so
-- re-grant the line to a user an admin had since unticked.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "commissionVisible" BOOLEAN NOT NULL DEFAULT false;

-- Everyone who already sees the line keeps it.
UPDATE "User" SET "commissionVisible" = true;
