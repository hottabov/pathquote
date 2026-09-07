/**
 * The document reads, kept at this one import path while the queries
 * themselves live in siblings split by what each one feeds: the /quotes
 * list, the builder's own document, the production forms, and the builder's
 * pickers.
 *
 * This file is a barrel and nothing else — every consumer sits in src/app/
 * or src/components/ and imports from "@/lib/queries/documents", so
 * re-exporting from here is what let that split happen without touching one
 * of them.
 *
 * `Document` here is a customer quote, rendered under `/quotes`; the
 * legal-documents feature (Terms, General Conditions of Sale, RSP) is a
 * separate model.
 */

export * from "./documents-list";
export * from "./documents-builder";
export * from "./documents-forms";
export * from "./documents-pickers";
