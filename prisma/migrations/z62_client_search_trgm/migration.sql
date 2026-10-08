-- Trigram indexes for the quote builder's client search
-- (decision D2, docs/superpowers/specs/2026-10-08-act-visibility-and-search.md).
--
-- The picker used to preload every visible company with every contact and
-- filter in the browser. After the ACT! import that was 8,810 companies and
-- 10,473 contacts, 2,158 kB of JSON on every builder page open (measured on the
-- rehearsal database, 2026-10-08; the SQL itself took 29 ms). The picker now
-- asks the server for the 20 best matches instead -- see
-- src/lib/queries/client-search.ts -- and these indexes are what keep that
-- question cheap as the client base grows.
--
-- Why trigram and not a prefix (text_pattern_ops) index: a manager who types
-- "noi" expects to find "PT Noitex", not only names that start with "noi". A
-- case-insensitive `contains` is `ILIKE '%noi%'`, which a btree cannot serve at
-- all, because the pattern has no fixed start. A GIN index over gin_trgm_ops
-- can, for any pattern of three or more characters; below that the planner
-- falls back to a scan, which is why the query code treats a search term
-- shorter than three characters as "no search" and lists the first page
-- instead (CLIENT_SEARCH_MIN_LENGTH in src/lib/client-search.ts).
--
-- Where Prisma stands on these. The three indexes ARE declared in
-- schema.prisma (`type: Gin`, `ops: raw("gin_trgm_ops")`, with the `map:` names
-- below), and the CREATE INDEX statements here are exactly what
-- `prisma migrate diff --from-schema <before> --to-schema <after> --script`
-- prints for that declaration. That is deliberate and is what keeps the CI step
-- "Migrations reproduce schema.prisma" (`prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema.prisma --exit-code`)
-- quiet: Prisma introspects GIN indexes, so an index that existed only in SQL
-- would show up as drift, and the next `prisma migrate dev` would generate a
-- DROP INDEX for it. Do not remove the declarations from schema.prisma, and do
-- not rename an index on one side only.
--
-- The one thing that lives only in this file is the extension. Prisma does not
-- model it without the `postgresqlExtensions` preview feature, which this
-- project does not enable, so `migrate diff` neither expects nor reports it --
-- the same position as the CHECK constraint in z60_act_sync. The extension is
-- "trusted" from PostgreSQL 13, so the migrating role needs CREATE on the
-- database, not superuser; postgres:16-alpine ships it.
--
-- Additive only: no data is modified. Each CREATE INDEX holds a SHARE lock on
-- its table, which blocks writes (not reads) while it builds; over ~12,000
-- companies and ~11,600 contacts that is a fraction of a second apiece.
-- CONCURRENTLY is not used because Prisma runs a migration inside one
-- transaction, where it is not allowed.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Company_name_trgm_idx" ON "Company" USING GIN ("name" gin_trgm_ops);

CREATE INDEX "Contact_firstName_trgm_idx" ON "Contact" USING GIN ("firstName" gin_trgm_ops);

CREATE INDEX "Contact_lastName_trgm_idx" ON "Contact" USING GIN ("lastName" gin_trgm_ops);
