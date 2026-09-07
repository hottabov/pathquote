"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { renderQuoteDocumentPreview } from "@/lib/quote-document-preview";
import { sanitizeIfHtml } from "@/lib/rich-text";
import { revalidateQuoteDocument, revalidateQuoteDocumentList } from "@/lib/revalidate";
import { DOCUMENT_TOKENS, findUnknownTokens } from "@/lib/quote-variables";
import {
  QUOTE_DOCUMENT_KEY_REGEX,
  quoteDocumentSchema,
  newQuoteDocumentSchema,
  reorderQuoteDocumentsSchema,
  isQuoteDocumentKeyPermutation,
  regionCodeSchema,
} from "@/lib/validation/quote-documents";
import { flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function readQuoteDocumentForm(formData: FormData) {
  return {
    title: formData.get("title"),
    body: formData.get("body"),
    includedByDefault: formData.get("includedByDefault"),
  };
}

/** Rejects a body carrying a token the document scope has no data for — the
 * editor's palette only ever offers `DOCUMENT_TOKENS`, so reaching here means
 * a hand-typed or pasted one. Same check, and the same wording,
 * `updateSeriesQuoteDescription` (src/lib/actions/catalog/series.ts) makes
 * for the category scope. */
function unknownDocumentTokenError(body: string): string | null {
  const unknown = findUnknownTokens(body, DOCUMENT_TOKENS);
  if (unknown.length === 0) return null;
  return `No value exists for ${unknown.map((t) => `{{${t}}}`).join(", ")} in a quote document. Remove it or pick a variable from the list.`;
}

/** Resolves a region code to its id, or `null` for the default (regionId
 * null) row. Returns `{ error }` if a non-null code doesn't match an
 * existing region. Byte-identical in spirit to `resolveRegionId` in
 * src/lib/actions/content.ts, the module this replaces. */
async function resolveRegionId(regionCode: string | null): Promise<{ error: string } | { regionId: string | null }> {
  if (regionCode === null) return { regionId: null };
  const parsed = regionCodeSchema.safeParse(regionCode);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };
  const region = await db.region.findUnique({ where: { code: parsed.data } });
  if (!region) return { error: "Region not found" };
  return { regionId: region.id };
}

/**
 * Creates or updates the `QuoteDocument` at `key` for `regionCode` (or the
 * region-null default when `regionCode` is null).
 *
 * Find-then-write, not upsert: Postgres treats `NULL != NULL`, so
 * `@@unique([key, regionId])` never constrains two default rows (regionId:
 * null) at the Postgres level — a naive `db.quoteDocument.upsert` keyed on
 * that composite could not tell "the default already exists" from "create a
 * second one". This always finds the existing row first and writes against
 * its id; a P2002 from a genuine race (two admins saving the same new region
 * version at the same moment) is retried as an update against whichever row
 * won, rather than failing the whole save. Exactly the pattern
 * `updateContentBlock` used in the file this replaces.
 *
 * `body` is HTML from the `RichTextEditor` (or legacy markdown for a key
 * nobody has re-saved through it yet) — `sanitizeIfHtml` allowlist-sanitizes
 * it at this write boundary before it's ever stored, the one place that
 * actually stops something unwanted from being persisted (the read-side
 * `renderStoredRichText` sanitizes again defensively, but by then the row
 * already exists).
 */
export async function updateQuoteDocument(
  key: string,
  regionCode: string | null,
  formData: FormData
): Promise<ActionResult> {
  await requireAdmin();

  if (!QUOTE_DOCUMENT_KEY_REGEX.test(key)) return { error: "Invalid document key" };

  const parsed = quoteDocumentSchema.safeParse(readQuoteDocumentForm(formData));
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const tokenError = unknownDocumentTokenError(parsed.data.body);
  if (tokenError) return { error: tokenError };

  const resolved = await resolveRegionId(regionCode);
  if ("error" in resolved) return { error: resolved.error };
  const { regionId } = resolved;

  const data = {
    title: parsed.data.title,
    body: sanitizeIfHtml(parsed.data.body),
    includedByDefault: parsed.data.includedByDefault,
  };

  const existing = await db.quoteDocument.findFirst({ where: { key, regionId } });

  if (existing) {
    await db.quoteDocument.update({ where: { id: existing.id }, data });
  } else {
    try {
      // A fresh row this save is the first to touch — the same "create if
      // missing" branch `updateContentBlock` took. `sortOrder` has no field
      // in `quoteDocumentSchema` (an existing document's position is set by
      // `reorderQuoteDocuments`, never resubmitted with its own edit), so a
      // row created here starts at the column default and is picked up by
      // the next reorder.
      await db.quoteDocument.create({ data: { key, regionId, sortOrder: 0, ...data } });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await db.quoteDocument.findFirst({ where: { key, regionId } });
      if (!raced) throw error;
      await db.quoteDocument.update({ where: { id: raced.id }, data });
    }
  }

  revalidateQuoteDocument(key);
  return {};
}

/**
 * Creates a region version of `key`/`regionCode`. When a global default
 * exists, it's copied wholesale — title, body and sort order — and the
 * admin then edits the copy independently via `updateQuoteDocument`, same
 * behaviour as the old `createRegionOverride`.
 *
 * UNLIKE `createRegionOverride`, this also works when NO default exists at
 * all (D5: a region-only document, e.g. a Data Processing Agreement only an
 * EU entity offers) — rather than erroring for lack of anything to copy, it
 * writes a blank starting body the admin fills in next. That bootstrap row
 * is deliberately exempt from `quoteDocumentSchema`'s non-blank rule (this
 * function writes straight to the database, the same way `createRegionOverride`
 * always did); the very next `updateQuoteDocument` on it enforces that rule
 * as normal.
 */
export async function createRegionVersion(key: string, regionCode: string): Promise<ActionResult> {
  await requireAdmin();

  if (!QUOTE_DOCUMENT_KEY_REGEX.test(key)) return { error: "Invalid document key" };

  const parsedRegion = regionCodeSchema.safeParse(regionCode);
  if (!parsedRegion.success) return { error: flattenZodError(parsedRegion.error) };

  const region = await db.region.findUnique({ where: { code: parsedRegion.data } });
  if (!region) return { error: "Region not found" };

  const [defaultDoc, existingVersion] = await Promise.all([
    db.quoteDocument.findFirst({ where: { key, regionId: null } }),
    db.quoteDocument.findFirst({ where: { key, regionId: region.id } }),
  ]);
  if (existingVersion) return { error: "A version already exists for this region" };

  try {
    await db.quoteDocument.create({
      data: {
        key,
        regionId: region.id,
        // No default to copy a title from for a region-only document — the
        // key itself is the least-wrong placeholder, replaced the moment the
        // admin renames it.
        title: defaultDoc?.title ?? key,
        body: defaultDoc ? sanitizeIfHtml(defaultDoc.body) : "<p></p>",
        sortOrder: defaultDoc?.sortOrder ?? 0,
        includedByDefault: defaultDoc?.includedByDefault ?? true,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return { error: "A version already exists for this region" };
  }

  revalidateQuoteDocument(key);
  return {};
}

/**
 * Deletes the region version of `key`/`regionCode`, so that region falls
 * back to the default document again (or, for a region-only document with
 * no default, prints nothing at all — the same way a quote in any other
 * region already does). Never touches the default (`regionId: null`) row —
 * there is no `regionCode: null` overload of this action, and a
 * non-existent/invalid region code just fails with "Region not found"
 * rather than resolving to the default.
 */
export async function deleteRegionVersion(key: string, regionCode: string): Promise<ActionResult> {
  await requireAdmin();

  if (!QUOTE_DOCUMENT_KEY_REGEX.test(key)) return { error: "Invalid document key" };

  const parsedRegion = regionCodeSchema.safeParse(regionCode);
  if (!parsedRegion.success) return { error: flattenZodError(parsedRegion.error) };

  const region = await db.region.findUnique({ where: { code: parsedRegion.data } });
  if (!region) return { error: "Region not found" };

  const existing = await db.quoteDocument.findFirst({ where: { key, regionId: region.id } });
  if (!existing) return { error: "Version not found" };

  await db.quoteDocument.delete({ where: { id: existing.id } });

  revalidateQuoteDocument(key);
  return {};
}

/**
 * Creates a brand-new document family — a `regionId: null` default under a
 * key nothing has used yet. `createRegionVersion` is the only other path that
 * ever creates a region-only document (D2); this one always creates the
 * default. Together they are what makes "adding a Data Processing Agreement
 * for the EU" an admin task rather than a code change, which is the payoff
 * the spec claims for this whole feature.
 *
 * The key is refused if ANY row already holds it, not just a default row: a
 * region-only document has no default, so a `regionId: null` check alone
 * would happily let this create one — silently turning a document one entity
 * offers into a document every region prints, from a screen whose whole
 * promise was "a new document". Promoting a region-only document is a
 * deliberate act and belongs on its own editor page, not in a create form
 * that thinks it is starting from nothing.
 *
 * Returns the created key so the caller can send the admin straight to its
 * editor — the key it returns is the normalized one (`newQuoteDocumentSchema`
 * lowercases and trims), which is not necessarily what was typed.
 */
export async function createQuoteDocument(formData: FormData): Promise<ActionResult & { key?: string }> {
  await requireAdmin();

  const parsed = newQuoteDocumentSchema.safeParse({
    key: formData.get("key"),
    sortOrder: formData.get("sortOrder"),
    ...readQuoteDocumentForm(formData),
  });
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const tokenError = unknownDocumentTokenError(parsed.data.body);
  if (tokenError) return { error: tokenError };

  const existing = await db.quoteDocument.findFirst({ where: { key: parsed.data.key } });
  if (existing) return { error: keyTakenError(parsed.data.key) };

  try {
    await db.quoteDocument.create({
      data: {
        key: parsed.data.key,
        regionId: null,
        title: parsed.data.title,
        body: sanitizeIfHtml(parsed.data.body),
        sortOrder: parsed.data.sortOrder,
        includedByDefault: parsed.data.includedByDefault,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return { error: keyTakenError(parsed.data.key) };
  }

  revalidateQuoteDocumentList();
  return { key: parsed.data.key };
}

/** Names the key rather than saying "this key", because the key that
 * collided may not be the one the admin typed — `newQuoteDocumentSchema`
 * lowercases it, so someone typing "DPA" over an existing "dpa" needs to be
 * told which key they actually asked for. */
function keyTakenError(key: string): string {
  return `A document already uses the key "${key}" — open it from the Documents list, or pick another key.`;
}

/**
 * Renders `body` with sample figures, for the editor's Preview panel.
 *
 * A server action rather than a client-side render for two reasons. The
 * rendering itself goes through `renderStoredRichText`, whose sanitizer
 * (`isomorphic-dompurify`) the project deliberately keeps out of browser
 * chunks — and, more to the point, the markup produced here is handed
 * straight to `dangerouslySetInnerHTML`, so it must come out of the
 * allowlist, not out of whatever a legacy markdown row or a paste happens to
 * contain. Doing it here also means the preview and the printed quote share
 * one substitution path (see src/lib/quote-document-preview.ts) rather than
 * a second, drifting one written in the browser.
 *
 * `requireSession`, not `requireAdmin`: a MANAGER may read these documents
 * (that is the whole point of the Documents section), and this action only
 * ever formats text the caller already supplied — it reads nothing and
 * writes nothing.
 */
export async function previewQuoteDocument(body: string): Promise<ActionResult & { html?: string }> {
  await requireSession();

  if (typeof body !== "string" || body.trim() === "") {
    return { error: "Nothing to preview yet — write the document first." };
  }
  // Same ceiling `bodySchema` enforces on a save, so a preview can't be used
  // to hand the sanitizer an unbounded string.
  if (body.length > 20000) return { error: "Body must be at most 20000 characters" };

  return { html: renderQuoteDocumentPreview(body) };
}

/**
 * Reorders every quote document to match `keys`, writing each document
 * FAMILY's new `sortOrder` as its index in that array — same "reindex the
 * whole list in one transaction" shape `reorderProducts`
 * (src/lib/actions/catalog/products.ts) uses.
 *
 * Written to EVERY row sharing a key, not just the default: `updateMany`
 * where `key` matches touches the default row and every region's own
 * version together. `resolveQuoteDocuments` prints a region's own row at
 * THAT ROW's `sortOrder`, so leaving a region version's stale after a
 * global reorder would silently drift that region's print order away from
 * the order the admin just set everywhere else.
 *
 * `keys` must be a permutation of every distinct key the table currently
 * holds (checked via `isQuoteDocumentKeyPermutation`, same pattern
 * `reorderProducts` uses against `isProductPermutation`) so a stale or
 * foreign key can't sneak into the order.
 *
 * "Every distinct key" includes a key that exists only as a region version
 * (D2), which is why `listQuoteDocuments` — the list the drag UI is built
 * from — must return those too. While it returned defaults alone, the first
 * region-only document made every submitted order a strict subset, and this
 * check then rejected every reorder with "refresh and try again", advice a
 * refresh could not act on because it rebuilt the same short list.
 */
export async function reorderQuoteDocuments(keys: string[]): Promise<ActionResult> {
  await requireAdmin();

  const parsedOrder = reorderQuoteDocumentsSchema.safeParse(keys);
  if (!parsedOrder.success) return { error: flattenZodError(parsedOrder.error) };

  const rows = await db.quoteDocument.findMany({ select: { key: true }, distinct: ["key"] });
  const actualKeys = rows.map((r) => r.key);

  if (!isQuoteDocumentKeyPermutation(parsedOrder.data, actualKeys)) {
    return { error: "Document list doesn't match — refresh and try again" };
  }

  await db.$transaction(
    parsedOrder.data.map((key, index) =>
      db.quoteDocument.updateMany({ where: { key }, data: { sortOrder: index } })
    )
  );

  revalidateQuoteDocumentList();
  return {};
}
