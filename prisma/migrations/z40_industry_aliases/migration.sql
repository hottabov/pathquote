-- Alternative spellings for an industry, so a wrong or unfamiliar category name
-- resolves to the row it should have been instead of growing the list.
--
-- Merging already fixes duplicates that exist ("Retail trade" folded into
-- "Retail"), but it fixes them once: the source name disappears, and the next
-- import from ACT! -- whose industry list is typed by hand and gains a new
-- category or a typo whenever someone in sales invents one -- re-creates the
-- same duplicate. An alias is what survives that. It records the wrong
-- spelling permanently, pointed at the right row.
--
-- Nothing prints an alias. It exists only for matching: the picker on a client
-- card searches it, and the ACT! importer will look an incoming category up
-- here before it considers creating a row.

CREATE TABLE "IndustryAlias" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industryId" TEXT NOT NULL,
    CONSTRAINT "IndustryAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IndustryAlias_name_key" ON "IndustryAlias"("name");

-- Global, case-insensitive uniqueness, mirroring Industry_name_lower_key in
-- 10_industry_and_production_spec -- and for a stronger reason than that one
-- had. Two industries claiming the same alias would make an import ambiguous:
-- "Retail trade" would have no single correct destination, which is the one
-- thing this table exists to guarantee. The application check in
-- addIndustryAlias is check-then-act and races; this index is what actually
-- holds. Expressed in SQL because Prisma cannot declare a functional index.
CREATE UNIQUE INDEX "IndustryAlias_name_lower_key" ON "IndustryAlias" (LOWER("name"));

-- Every read of this table is "the aliases of this industry" -- the settings
-- list loads them per row, and mergeIndustries moves them by industryId.
CREATE INDEX "IndustryAlias_industryId_idx" ON "IndustryAlias"("industryId");

-- CASCADE, unlike Company.industryId's SET NULL. A company that loses its
-- industry is still a company; an alias with no industry is nothing at all --
-- it would be a name pointing nowhere that an import could still match. The
-- only path that deletes an industry with aliases attached is deleteIndustry
-- (refused while any company uses the row); mergeIndustries moves the aliases
-- onto the target first, inside its transaction, so this cascade never fires
-- there.
ALTER TABLE "IndustryAlias" ADD CONSTRAINT "IndustryAlias_industryId_fkey"
    FOREIGN KEY ("industryId") REFERENCES "Industry"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
