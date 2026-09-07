-- Retire ContentBlock, and the two columns that pointed into it.
--
-- ContentBlock held three unrelated kinds of text as key-prefixed fragments:
--
--   machine.* / equipment.*   category copy, now Series.quoteDescription
--                             (migration z34_series_quote_description, moved by
--                             scripts/migrate-content-blocks-to-series.ts)
--   option.* / software.*     copy for rows that had no reader left; deleted
--                             outright by that same script
--   terms.* / conditions.*    the legal documents, now QuoteDocument
--   / rsp.*                   (migration z36_quote_documents, moved by
--                             scripts/migrate-content-blocks-to-quote-documents.ts)
--
-- Both data migrations have been applied to the live database and verified
-- with scripts/verify-quote-document-migration.ts, which reports the
-- QuoteDocument rows that exist and the ContentBlock rows left and refuses a
-- clean verdict unless the table is empty. Run it once more before this
-- migration: DROP TABLE is not reversible without a restore, and the text it
-- destroys is the text a customer signs.
--
-- Product.contentBlockKey / Option.contentBlockKey named a block for each row.
-- Nothing resolved a key any more once category copy moved onto the category
-- (src/lib/quotation-data.ts reads Series.quoteDescription), so the columns
-- are dead weight that only kept dangling references alive. They also leave
-- the catalogue workbook: src/lib/catalog-xlsx/columns.ts drops both headers,
-- and parse.ts ignores them by name so an export taken before this change
-- still imports.
--
-- Destructive, which is the point.

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "contentBlockKey";

-- AlterTable
ALTER TABLE "Option" DROP COLUMN "contentBlockKey";

-- DropTable
DROP TABLE "ContentBlock";
