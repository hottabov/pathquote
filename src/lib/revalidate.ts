/**
 * Every `revalidatePath` the app performs, named once.
 *
 * The action layer used to hand-type its route strings at each of ~90 call
 * sites. A typo in any one of them is silent: the write succeeds, the page
 * it should have refreshed keeps serving the old render, and nothing —
 * not the type checker, not a test — notices. Naming each route here makes
 * a wrong path a compile error at worst and a one-line fix at best, and
 * gives the next route rename a single place to land.
 *
 * The helpers are deliberately per-page rather than per-action: an action
 * that refreshes both a list and one row on it calls two of them. Bundling
 * those pairs into one helper would read well for the majority and then
 * quietly force the minority — the loop in `setConflictGroupMembers`, the
 * detail-only write in `setCatalogVisibility` — to revalidate a page they
 * have no business touching. The pairs that *are* bundled below
 * (`revalidateCatalog`, `revalidateProduct`, `revalidateQuoteDocument`) are
 * the ones where every existing call site wanted the whole set.
 */

import { revalidatePath } from "next/cache";

/** The dashboard. Its greeting shows the signed-in user's own avatar. */
export function revalidateHome(): void {
  revalidatePath("/");
}

// --- documents ---------------------------------------------------------
// These name the **quotes** routes — `Document` is the quote model. The
// legal documents on /documents have their own pair at the end of this file.

export function revalidateDocumentList(): void {
  revalidatePath("/quotes");
}

export function revalidateDocument(documentId: string): void {
  revalidatePath(`/quotes/${documentId}`);
}

// --- clients ---------------------------------------------------------------

export function revalidateCompanyList(): void {
  revalidatePath("/clients");
}

export function revalidateCompany(companyId: string): void {
  revalidatePath(`/clients/${companyId}`);
}

// --- catalogue -------------------------------------------------------------

/**
 * The catalogue index, and — given a series id — that series' own page. The
 * index card for a series reflects what is inside it (product counts, a
 * fallback image), so a change to one series is a change to both pages.
 */
export function revalidateCatalog(seriesId?: string): void {
  revalidatePath("/catalog");
  if (seriesId !== undefined) revalidatePath(`/catalog/${seriesId}`);
}

/**
 * A product's page and the series page that lists it. Not the catalogue
 * index: callers that also need it say so by calling `revalidateCatalog()`
 * alongside.
 */
export function revalidateProduct(seriesId: string, productId: string): void {
  revalidatePath(`/catalog/${seriesId}/${productId}`);
  revalidatePath(`/catalog/${seriesId}`);
}

/**
 * Every catalogue page at once -- the index, every series, every product,
 * the options list and every option. Only the catalogue import
 * (src/lib/actions/catalog-import.ts) has any business with this: it can
 * touch any number of rows in one transaction, so enumerating the pages it
 * changed would just re-derive "all of them". `'layout'` invalidates the
 * segment and everything beneath it.
 */
export function revalidateCatalogTree(): void {
  revalidatePath("/catalog", "layout");
}

export function revalidateOptionList(): void {
  revalidatePath("/catalog/options");
}

export function revalidateOption(optionId: string): void {
  revalidatePath(`/catalog/options/${optionId}`);
}

// --- settings --------------------------------------------------------------

export function revalidateSettings(): void {
  revalidatePath("/settings");
}

export function revalidateSpecImages(): void {
  revalidatePath("/settings/spec-images");
}

export function revalidateSupport(): void {
  revalidatePath("/settings/support");
}

export function revalidateImportExport(): void {
  revalidatePath("/settings/import-export");
}

export function revalidateUserList(): void {
  revalidatePath("/settings/users");
}

export function revalidateUser(userId: string): void {
  revalidatePath(`/settings/users/${userId}`);
}

export function revalidateRegionList(): void {
  revalidatePath("/settings/regions");
}

export function revalidateRegion(regionId: string): void {
  revalidatePath(`/settings/regions/${regionId}`);
}

export function revalidateIndustryList(): void {
  revalidatePath("/settings/industries");
}

export function revalidateConflictGroupList(): void {
  revalidatePath("/settings/option-conflict-groups");
}

export function revalidateConflictGroup(groupId: string): void {
  revalidatePath(`/settings/option-conflict-groups/${groupId}`);
}

// --- quote documents ---------------------------------------------------
// Terms, General Conditions, RSP, and whatever a region adds later — the
// legal text a customer signs, edited as whole documents rather than the
// ContentBlock fragments they used to be (see
// docs/superpowers/plans/2026-09-07-quote-documents.md).

export function revalidateQuoteDocumentList(): void {
  revalidatePath("/documents");
}

/**
 * The quote-document list and the editor for one document. The key is a
 * user-defined string that reaches the route as a path segment, so it is
 * encoded here — the one route in the app whose parameter is not an id.
 */
export function revalidateQuoteDocument(key: string): void {
  revalidatePath("/documents");
  revalidatePath(`/documents/${encodeURIComponent(key)}`);
}
