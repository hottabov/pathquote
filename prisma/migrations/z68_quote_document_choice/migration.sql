-- A quote can now ask for a document its region does not print by default
-- (an optional agreement such as RSP Plus), not only leave out one it does.
--
-- `DocumentExclusion` stored only what a quote unticked, so a document an
-- admin set to "not included by default" could never reach a quote at all.
-- The table becomes `QuoteDocumentChoice`, one row per (quote, document key)
-- with the decision in `included`. Every existing row is an exclusion, so it
-- becomes `included = false` and every quote prints exactly what it printed
-- before. Renamed in place: no row is deleted or rewritten.

ALTER TABLE "DocumentExclusion" RENAME TO "QuoteDocumentChoice";
ALTER TABLE "QuoteDocumentChoice" RENAME CONSTRAINT "DocumentExclusion_pkey" TO "QuoteDocumentChoice_pkey";
ALTER TABLE "QuoteDocumentChoice" RENAME CONSTRAINT "DocumentExclusion_documentId_fkey" TO "QuoteDocumentChoice_documentId_fkey";

ALTER TABLE "QuoteDocumentChoice" ADD COLUMN "included" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "QuoteDocumentChoice" ALTER COLUMN "included" DROP DEFAULT;
