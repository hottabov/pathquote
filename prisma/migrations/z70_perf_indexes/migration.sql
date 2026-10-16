-- Indexes for the two list pages, from the 2026-10-16 performance audit
-- (docs/technical-audit/FINDINGS.md, PERF-05 and PERF-06). Additive only.
--
-- Document: listDocuments filters a MANAGER by authorId and a REGIONAL_MANAGER
-- by regionId, and orders every scope by updatedAt DESC. The existing
-- single-column indexes serve one half each.
CREATE INDEX "Document_authorId_updatedAt_idx" ON "Document"("authorId", "updatedAt");
CREATE INDEX "Document_regionId_updatedAt_idx" ON "Document"("regionId", "updatedAt");

-- Company: listCompanies pages with ORDER BY name, id; only a trigram GIN
-- index existed on name, which cannot serve a sort.
CREATE INDEX "Company_name_id_idx" ON "Company"("name", "id");
