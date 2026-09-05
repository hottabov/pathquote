"use server";

/**
 * How a draft presents itself: the image/price/notes display flags, the
 * record-keeping serial number, the per-quote validity window, and the
 * delivery terms. All of them are single-statement writes that fold their
 * own `status: "DRAFT"` check into the `updateMany` (see the note in
 * _internal.ts) — the one exception is `setDeliveryTerms`, which moves the
 * tax and so takes the guarded transaction the pricing actions use.
 */

import { revalidateDocument } from "@/lib/revalidate";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { recalcAndEnforce } from "@/lib/documents/recalc";
import { isHtmlContent, sanitizeRichText } from "@/lib/rich-text";
import { IMAGE_URL_PATTERN } from "@/lib/uploads";
import {
  deliveryTermsSchema,
  idSchema,
  notesSchema,
  priceDisplaySchema,
  serialNumberSchema,
  validityDaysSchema,
} from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError } from "../_shared";
import { assertStillDraft, mapDraftWriteError, type ActionResult } from "./_internal";

/**
 * Toggles whether an item's product image is shown on the rendered
 * document (sheet/PDF — see `toSheetData`'s `showImage && imageUrl` check
 * in src/lib/sheet-data.ts). Scoped through the item -> document chain like
 * `setItemDiscount`, DRAFT-only, same as every other item mutation in this
 * directory. Purely a display flag — it doesn't affect pricing, so unlike
 * `setItemDiscount`/`setItemOptions` there's no `recalcDocument` call here.
 */
export async function setItemShowImage(itemId: string, show: boolean): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const updated = await db.documentItem.updateMany({
    where: { id: item.id, document: { status: "DRAFT" } },
    data: { showImage: show },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(item.documentId);
  return {};
}

/**
 * Sets the serial number of the machine a credit item (today: the TRADE-IN
 * product) is taking in trade. `DocumentItem.serialNumber` exists for every
 * item but is not editable anywhere else in the builder — it's opened up
 * here specifically so a salesperson can record which physical machine was
 * traded. Purely a record-keeping field — it doesn't affect pricing, so like
 * `setItemShowImage` there's no `recalcDocument` call.
 */
export async function setItemSerialNumber(itemId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const parsed = serialNumberSchema.safeParse(formData.get("serialNumber"));
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const item = await db.documentItem.findFirst({
    where: {
      id: parsedItemId.data,
      document: { status: "DRAFT", ...documentWhereForUser(session.user) },
    },
    select: { id: true, documentId: true },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const updated = await db.documentItem.updateMany({
    where: { id: item.id, document: { status: "DRAFT" } },
    data: { serialNumber: parsed.data },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(item.documentId);
  return {};
}

// --- price display toggles (quotation-first) --------------------------------

/**
 * Sets both quotation pricing-display toggles at once (the builder UI always
 * submits the pair together — see `PriceDisplayToggles` — so there's no
 * partial-update variant like the item discount fields have). Purely a
 * display flag pair, same as `setItemShowImage`: they never affect
 * `subtotal`/`taxAmount`/`total`, so there's no `recalcDocument` call here.
 * DRAFT-only and scoped like every other document mutation in this directory.
 */
export async function setPriceDisplay(documentId: string, input: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedInput = priceDisplaySchema.safeParse(input);
  if (!parsedInput.success) return { error: flattenZodError(parsedInput.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: {
      showItemPrices: parsedInput.data.showItemPrices,
      showOptionPrices: parsedInput.data.showOptionPrices,
    },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}

// --- notes (Task: free-text notes) ------------------------------------------

/**
 * Sets (or, given a blank body, clears) `Document.notes` — the builder's
 * freeform Notes section (HTML from the `RichTextEditor`, or legacy markdown
 * for a row a pre-migration editor saved and nobody has re-opened since;
 * rendered on both the quotation sheet and the plain document sheet via
 * `renderStoredRichText` — see `QuotationData.notesHtml`/
 * `DocSheetData.notes`). HTML content is allowlist-sanitized before it ever
 * reaches the database (`sanitizeRichText`) — the read-side `renderStoredRichText`
 * sanitizes again defensively, but the write boundary is the one place that
 * actually stops something unwanted from being persisted at all. DRAFT-only
 * and scoped like every other document mutation in this directory; purely a
 * display field, so unlike `setItemDiscount`/`setDocumentDiscount` there's
 * no `recalcDocument` call here (mirrors `setItemShowImage`/
 * `setPriceDisplay`).
 */
export async function setDocumentNotes(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedNotes = notesSchema.safeParse(formData.get("notes"));
  if (!parsedNotes.success) return { error: flattenZodError(parsedNotes.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const notes =
    parsedNotes.data !== null && isHtmlContent(parsedNotes.data) ? sanitizeRichText(parsedNotes.data) : parsedNotes.data;

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: { notes },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}

/** Validates a submitted hero-image URL is either `null` (clear it) or
 * exactly the `/api/files/<uuid>.<ext>` shape `saveUpload` produces — mirrors
 * `parseImageUrl` in src/lib/actions/catalog.ts/regions.ts, duplicated
 * locally rather than shared since none of those modules export it. */
function parseHeroImageUrl(url: string | null): { ok: true; value: string | null } | { ok: false } {
  if (url === null) return { ok: true, value: null };
  if (!IMAGE_URL_PATTERN.test(url)) return { ok: false };
  return { ok: true, value: url };
}

/**
 * Sets (or, given `null`, clears) the quotation's setup image
 * (`Document.heroImageUrl` — see that column's doc comment in schema.prisma)
 * — one photo for the whole quote, uploaded from the builder via
 * `/api/uploads` (purpose `document-hero`) then persisted here, same
 * two-step flow as `updateProductImage`/`updateRegionLogo`. DRAFT-only and
 * scoped like every other document mutation in this directory; purely a
 * display field, so unlike `setItemDiscount`/`setDocumentDiscount` there's no
 * `recalcDocument` call here (mirrors `setItemShowImage`/`setDocumentNotes`).
 */
export async function setDocumentHeroImage(documentId: string, url: string | null): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedUrl = parseHeroImageUrl(url);
  if (!parsedUrl.ok) return { error: "Invalid image URL" };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: { heroImageUrl: parsedUrl.value },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}

// --- validity (per-quote override) ------------------------------------------

/**
 * Sets (or, given a blank value, clears) `Document.validityDays` — a
 * per-quote override of the org-wide "quote.validityDays" setting (see
 * `getQuoteValidityDays`, src/lib/queries/settings.ts). A salesperson uses
 * this when a particular customer's capex approval process runs longer than
 * the usual window (owner: "I'll give you eight [weeks]" in place of the
 * default). `validityDaysSchema` allows any value 1..365 — the 30-day norm
 * enforced elsewhere is a UI-level warning, not a hard cap here, since a
 * genuinely slower approval process is a legitimate reason to exceed it and
 * the discount cap already covers the case where money is actually at risk.
 * Clearing the field back to blank reverts the document to the org-wide
 * default at finalize time (see `finalizeDocument`'s
 * `document.validityDays ?? (await getQuoteValidityDays())` fallback).
 * DRAFT-only and scoped like every other document mutation in this
 * directory; purely a display/finalize-time field, so — like
 * `setItemShowImage`/`setPriceDisplay`/`setDocumentNotes` — there's no
 * `recalcDocument` call here.
 */
export async function setValidityDays(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedValidityDays = validityDaysSchema.safeParse(formData.get("validityDays"));
  if (!parsedValidityDays.success) return { error: flattenZodError(parsedValidityDays.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: { validityDays: parsedValidityDays.data },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}

// --- delivery terms (Ex Works carries no GST) -------------------------------

/**
 * Sets `Document.deliveryTerms` — DELIVERED (the default) or EX_WORKS, an
 * export sale collected at the factory door, which is not a domestic taxable
 * supply (the meeting question left unanswered: "What if there's no GST? If
 * it's Ex Works?"). Unlike the purely-display fields above (`setItemShowImage`/
 * `setPriceDisplay`/`setDocumentNotes`/`setValidityDays`), this one *does*
 * change what's owed — `recalcDocument` resolves an EX_WORKS document's
 * effective tax rate to zero (see its own doc comment) — so this follows the
 * same guarded-transaction + `recalcAndEnforce` pattern as every
 * money-affecting mutation in this directory, even though toggling terms alone
 * can never itself trip `negativeSubtotal` or either concession cap (both are
 * computed pre-tax) — same "no special-casing a 'safe' mutation" reasoning
 * `addItem`'s own comment gives. DRAFT-only and scoped like every other
 * document mutation here.
 */
export async function setDeliveryTerms(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedTerms = deliveryTermsSchema.safeParse(formData.get("deliveryTerms"));
  if (!parsedTerms.success) return { error: flattenZodError(parsedTerms.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      await tx.document.update({ where: { id: document.id }, data: { deliveryTerms: parsedTerms.data } });
      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return concessionWarning ? { warning: concessionWarning } : {};
}
