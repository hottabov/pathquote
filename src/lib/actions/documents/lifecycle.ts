"use server";

/**
 * A document's existence and who it is for: creating a draft, deleting one
 * (or, for an ADMIN, a finalized document), and assigning the client. None
 * of these touches money, so none of them recalculates — everything that
 * does lives in the sibling modules.
 */

import { revalidateDocument, revalidateDocumentList } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { isAdminRole } from "@/lib/roles";
import { companyWhereForUser, documentWhereForUser } from "@/lib/scope";
import { idSchema, optionalIdSchema } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR } from "../_shared";
import type { ActionResult } from "./_internal";

const FALLBACK_REGION_CODE = "AU";

/**
 * Creates a DRAFT quote and redirects straight into its builder — the
 * "New quote" button on /documents submits with no fields, so the draft
 * exists before a client is even picked (companyId stays null until
 * setDocumentClient). Region/currency/tax are snapshotted from the author's
 * own region, falling back to AU for an author with no region assigned yet.
 */
export async function createDraft(): Promise<void> {
  const session = await requireSession();

  const region = session.user.regionId
    ? await db.region.findUnique({ where: { id: session.user.regionId } })
    : null;
  const resolvedRegion = region ?? (await db.region.findUnique({ where: { code: FALLBACK_REGION_CODE } }));
  if (!resolvedRegion) {
    throw new Error("No region configured");
  }

  const created = await db.document.create({
    data: {
      status: "DRAFT",
      authorId: session.user.id,
      regionId: resolvedRegion.id,
      currency: resolvedRegion.currency,
      taxName: resolvedRegion.taxName,
      taxRate: resolvedRegion.taxRate,
    },
  });

  revalidateDocumentList();
  redirect(`/documents/${created.id}`);
}

/** Deletes a DRAFT document (items/lines cascade — see schema). Scoped to
 * the caller and restricted to DRAFT status: a FINAL document is never
 * deletable through this action. */
export async function deleteDraft(documentId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const existing = await db.document.findFirst({
    where: { id: parsedId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!existing) return { error: NOT_FOUND_ERROR };

  const deleted = await db.document.deleteMany({ where: { id: existing.id, status: "DRAFT" } });
  if (deleted.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocumentList();
  redirect("/documents");
}

/**
 * Permanently deletes a document of any status, from the /documents list.
 * Items/lines cascade via `onDelete: Cascade` (schema.prisma).
 *
 * Scoped like every other action here (`documentWhereForUser`: a MANAGER
 * only ever finds their own documents, an ADMIN finds any), plus one extra
 * rule this action alone enforces: a FINAL document — one that was issued a
 * permanent, never-reused number (see numbering.ts) — may only be deleted by
 * an ADMIN, regardless of who authored it. A DRAFT has no such restriction
 * beyond the usual scope check.
 */
export async function deleteDocument(documentId: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsedId = idSchema.safeParse(documentId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: parsedId.data, ...documentWhereForUser(session.user) },
    select: { id: true, status: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  if (document.status === "FINAL" && !isAdminRole(session.user.role)) {
    return { error: "Only an admin can delete a finalized document" };
  }

  await db.document.delete({ where: { id: document.id } });

  revalidateDocumentList();
  return {};
}

// --- client step -----------------------------------------------------------

/**
 * Sets (or changes) a draft's client company and, optionally, a contact at
 * that company. Both are re-verified against the caller's scope/relationship
 * here — never trust a companyId/contactId submitted from the client as-is:
 * the company must satisfy `companyWhereForUser`, and the contact (if any)
 * must actually belong to that company. Only DRAFT documents are editable.
 *
 * When `contactId` is omitted/empty, the company's primary contact is
 * auto-assigned instead of leaving the document contact-less: `isPrimary`
 * first, else the first contact by the same ordering the client picker uses
 * (`isPrimary` desc, `firstName` asc — see `listClientPickerCompanies`), or
 * `null` if the company has no contacts at all. This is what lets the
 * builder's company select persist a usable contact in one step — the
 * explicit contact dropdown then still overrides it by passing a concrete
 * `contactId`.
 */
export async function setDocumentClient(
  documentId: string,
  companyId: string,
  contactId?: string | null
): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  const parsedCompanyId = idSchema.safeParse(companyId);
  const parsedContactId = optionalIdSchema.safeParse(contactId ?? undefined);
  if (!parsedDocumentId.success || !parsedCompanyId.success || !parsedContactId.success) {
    return { error: "Invalid input" };
  }

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const company = await db.company.findFirst({
    where: { id: parsedCompanyId.data, ...companyWhereForUser(session.user) },
  });
  if (!company) return { error: "Company not found" };

  let resolvedContactId: string | null = null;
  if (parsedContactId.data) {
    const contact = await db.contact.findFirst({
      where: { id: parsedContactId.data, companyId: company.id },
    });
    if (!contact) return { error: "Contact not found" };
    resolvedContactId = contact.id;
  } else {
    const primaryContact = await db.contact.findFirst({
      where: { companyId: company.id },
      orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }],
    });
    resolvedContactId = primaryContact?.id ?? null;
  }

  const updated = await db.document.updateMany({
    where: { id: document.id, status: "DRAFT" },
    data: { companyId: company.id, contactId: resolvedContactId },
  });
  if (updated.count !== 1) return { error: NOT_FOUND_ERROR };

  revalidateDocument(document.id);
  return {};
}
