-- Commission tiers move from one global table to each user.
--
-- Until now every salesperson earned by the same table, stored as the Setting
-- row "commission.tiers" and edited in Settings -> Preferences, and
-- z66_commission_visible decided per user whether the builder showed the
-- figure at all. Pathfinder now pays its managers differently: some earn less
-- as the discount grows, some a flat rate whatever the discount. So the table
-- lives on the user (`User.commissionTiers`, edited in Settings -> Users ->
-- <user>) and is read off the quote's author.
--
-- An empty table means no commission, which is also what made the
-- `commissionVisible` flag redundant: a user who should not see a commission
-- (a distributor) simply has none. So the flag goes, in this same migration.
--
-- What each existing user gets:
--
--   * shown the commission until now (commissionVisible = true): the global
--     table exactly as it stood, so nobody's figure changes on deploy. If the
--     Setting row was never saved, the app was paying the table it ships with
--     (DEFAULT_COMMISSION_TIERS, src/lib/pricing.ts), so that is what is
--     copied, written out below value for value. If an admin had saved an
--     empty table, the copy is empty too -- again exactly what they had.
--   * not shown it (commissionVisible = false -- distributors): `[]`, the
--     column default. They saw no figure before and see none now.
--
-- Additive for documents: no `Document` row is read or written. FINAL quotes
-- keep the commission frozen on them at finalize; drafts recompute from their
-- author's table on the next edit, which for every author above is the table
-- they were already on.
--
-- Order matters: the UPDATE reads `commissionVisible` and the Setting row, so
-- it runs before the DROP and the DELETE. Applied once (`_prisma_migrations`),
-- which is why the copy lives here and not in a script.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "commissionTiers" JSONB NOT NULL DEFAULT '[]';

UPDATE "User"
SET "commissionTiers" = COALESCE(
  (SELECT "value" FROM "Setting" WHERE "key" = 'commission.tiers'),
  '[{"minPct":0,"maxPct":0,"ratePct":5},{"minPct":0.01,"maxPct":5,"ratePct":4.75},{"minPct":5.01,"maxPct":10,"ratePct":4.5},{"minPct":10.01,"maxPct":15,"ratePct":4.25},{"minPct":15.01,"maxPct":null,"ratePct":4}]'::jsonb
)
WHERE "commissionVisible" = true;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "commissionVisible";

-- The global table is gone; nothing reads this key any more.
DELETE FROM "Setting" WHERE "key" = 'commission.tiers';
