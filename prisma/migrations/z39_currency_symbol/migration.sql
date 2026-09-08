-- An explicit currency symbol per region, and its per-document snapshot.
--
-- Until now every amount was printed by Intl.NumberFormat from the three-letter
-- currency code alone (src/lib/format.ts). Intl's en-AU narrow symbol is "$"
-- for AUD and "£" for GBP, but plain "USD" for US dollars -- so a US region's
-- paperwork read "USD 175,000" where the office wanted "$175,000". Owner wants
-- to type the symbol in rather than argue with a locale table.
--
-- Nullable on both tables, and null keeps the old behaviour verbatim: fall back
-- to whatever Intl derives. So this migration changes nothing on its own; every
-- existing region and document renders exactly as it did until someone fills
-- the field in.
--
-- Document.currencySymbol is a snapshot, copied from the region at createDraft
-- alongside currency/taxName/taxRate, for the same reason those are snapshots:
-- a quote must print the same amounts on the day it is signed as on the day it
-- was drafted. An admin correcting a region's symbol changes new quotes only.

-- AlterTable
ALTER TABLE "Region" ADD COLUMN "currencySymbol" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "currencySymbol" TEXT;
