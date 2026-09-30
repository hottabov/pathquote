-- READ-ONLY. Run against production BEFORE deploying z59_tax_incoterms to
-- list the drafts whose tax will change on their next recalc. Show the list
-- to Vadym. Finalized quotes are frozen and never appear here.

-- Query 1: the country each region will get. Every country must be a 2-letter
-- ISO code, or the migration will refuse to run.
SELECT code,
       name,
       CASE UPPER(code) WHEN 'UK' THEN 'GB' ELSE UPPER(code) END AS country_after_migration
  FROM "Region"
 ORDER BY code;

-- Query 2: the drafts whose tax changes.
WITH d AS (
  SELECT doc.id,
         doc."number",
         r.code AS region,
         CASE UPPER(r.code) WHEN 'UK' THEN 'GB' ELSE UPPER(r.code) END AS seller,
         UPPER(TRIM(COALESCE(
           CASE WHEN c."deliverySameAsMain" THEN NULL ELSE NULLIF(TRIM(c."deliveryCountry"), '') END,
           NULLIF(TRIM(c.country), '')
         ))) AS destination,
         c.name AS client,
         doc."deliveryTerms",
         doc."taxName",
         doc."taxRate",
         doc.total
    FROM "Document" doc
    JOIN "Region" r ON r.id = doc."regionId"
    LEFT JOIN "Company" c ON c.id = doc."companyId"
   WHERE doc.status = 'DRAFT'
)
SELECT *,
       CASE
         WHEN destination IS NULL THEN 'no destination: finalize will ask for it'
         WHEN "deliveryTerms" = 'EX_WORKS' AND destination = seller THEN 'domestic EXW: tax goes from 0 to the region rate'
         WHEN "deliveryTerms" = 'DELIVERED' AND destination <> seller THEN 'foreign delivery: tax goes to 0 (export)'
       END AS change
  FROM d
 WHERE destination IS NULL
    OR ("deliveryTerms" = 'EX_WORKS' AND destination = seller)
    OR ("deliveryTerms" = 'DELIVERED' AND destination <> seller)
 ORDER BY region, client;
