-- A new quote shows its per-item and per-option prices by default.
--
-- Both columns defaulted to false, so every quote began with the customer
-- able to see one grand total and nothing else, and the salesperson had to
-- remember two tickboxes on the Quote terms tab to show the detail that the
-- quotation sheet is built around. The owner's quotes almost always show it
-- (Vadym, 2026-09-23), which makes false the wrong starting point.
--
-- Defaults only: existing quotes keep whatever they were saved with, since
-- an issued quote must print the same thing tomorrow as it did today.
ALTER TABLE "Document" ALTER COLUMN "showItemPrices" SET DEFAULT true,
ALTER COLUMN "showOptionPrices" SET DEFAULT true;
