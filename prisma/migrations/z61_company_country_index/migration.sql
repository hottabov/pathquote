-- Index Company.country.
--
-- Country-based client visibility (decision D1,
-- docs/superpowers/specs/2026-10-08-act-visibility-and-search.md): a manager
-- who holds a country grant sees every company whose country is in it, so
-- companyWhereForUser (src/lib/scope.ts) now filters on `country IN (...)`
-- for each such manager on every clients list, client page and client picker.
-- Without an index that is a sequential scan of ~12,000 imported rows each
-- time.
--
-- Additive only: no data is modified. A plain CREATE INDEX holds a SHARE lock
-- on Company, which blocks writes (not reads) for the duration of the build;
-- on ~12,000 rows that is a fraction of a second. CONCURRENTLY is not used
-- because Prisma runs a migration inside one transaction, where it is not
-- allowed.

CREATE INDEX "Company_country_idx" ON "Company"("country");
