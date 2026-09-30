-- The MTS price now covers six metres of travel, not nine; MTS-M is billed
-- per metre past that (MTS_INCLUDED_M, src/lib/production-forms/mts.ts).
-- The option's description says the same. Found by role, not code, and
-- only the figure is replaced, so any other wording an admin has given it
-- stays. No Document rows are touched: a quote keeps the description it was
-- written with.
UPDATE "Option"
   SET "shortDescription" = REPLACE("shortDescription", 'more than 9 mtrs', 'more than 6 mtrs')
 WHERE "role" = 'MTS'
   AND "shortDescription" LIKE '%more than 9 mtrs%';
