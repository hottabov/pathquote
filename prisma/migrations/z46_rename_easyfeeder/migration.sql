-- The product is the EasyFeeder, so the form value says so too
-- (Vadym, 2026-09-17). RENAME VALUE rewrites the label in place: every
-- Product row that printed EASYFEED now reads EASYFEEDER, with no data
-- migration and no gap in which a row holds a value the client does not know.
ALTER TYPE "ProductionForm" RENAME VALUE 'EASYFEED' TO 'EASYFEEDER';
