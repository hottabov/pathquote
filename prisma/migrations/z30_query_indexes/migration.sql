-- Indexes for columns the app already filters and sorts on.
--
-- Nothing about the data model changes here. Each index below answers a
-- query that exists today and was reaching it by sequential scan; the
-- schema.prisma comment sitting next to each `@@index` names the caller and
-- says why an existing unique constraint could not already serve it (in
-- every case because the constraint leads with a different column, and a
-- btree is only usable from its leftmost column inwards).
--
-- Plain CREATE INDEX, not CONCURRENTLY, deliberately. `prisma migrate
-- deploy` wraps each migration in a transaction and Postgres forbids
-- CREATE INDEX CONCURRENTLY inside one, so CONCURRENTLY here would not
-- merely be slower to write -- it would fail outright. Nor is it wanted:
-- CONCURRENTLY exists to avoid holding a write lock over a long build, and
-- these tables are tiny (66 products, ~140 compatibility rows, documents in
-- the low hundreds). Every index below builds in milliseconds, well inside
-- what a deploy already blocks for.

-- CreateIndex
CREATE INDEX "Product_seriesId_idx" ON "Product"("seriesId");

-- CreateIndex
CREATE INDEX "OptionConflictGroupMember_optionId_idx" ON "OptionConflictGroupMember"("optionId");

-- CreateIndex
CREATE INDEX "OptionCompatibility_seriesId_idx" ON "OptionCompatibility"("seriesId");

-- CreateIndex
CREATE INDEX "OptionCompatibility_productId_idx" ON "OptionCompatibility"("productId");

-- CreateIndex
CREATE INDEX "Document_updatedAt_idx" ON "Document"("updatedAt");

-- CreateIndex
CREATE INDEX "Document_contactId_idx" ON "Document"("contactId");

-- CreateIndex
CREATE INDEX "DocumentItem_productId_idx" ON "DocumentItem"("productId");

-- CreateIndex
CREATE INDEX "DocumentLine_refId_kind_idx" ON "DocumentLine"("refId", "kind");

-- CreateIndex
CREATE INDEX "ContentBlock_regionId_idx" ON "ContentBlock"("regionId");
