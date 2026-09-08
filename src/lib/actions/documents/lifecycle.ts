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
import { requireRegion, requireSession } from "@/lib/authz";
import { isAdminRole } from "@/lib/roles";
import { companyWhereForUser, documentWhereForUser, REGION_REQUIRED_ERROR } from "@/lib/scope";
import { idSchema, optionalIdSchema } from "@/lib/validation/documents";
import { canDeleteDocument } from "@/lib/signing/state";
import { NOT_FOUND_ERROR } from "../_shared";
import type { ActionResult } from "./_internal";

/**
 * Creates a DRAFT quote and redirects straight into its builder — the
 * "New quote" button on /quotes submits with no fields, so the draft
 * exists before a client is even picked (companyId stays null until
 * setDocumentClient). Region/currency/tax are snapshotted from the author's
 * own region, which is required: an author with no region cannot create a
 * quote at all.
 */
export async function createDraft(): Promise<void> {
  // `requireRegion`, not `requireSession`, and not a bare throw. No fallback
  // region: this used to resolve a region-less author to AU and copy AU's
  // currency and tax rate onto the quote — wrong in every region but AU, and
  // silent in all of them.
  //
  // This guards itself rather than leaning on the Documents layout because
  // NO caller goes through that layout — a server action never does. The
  // action body runs before any layout renders, so a form under
  // `quotes/` inherits nothing from `DocumentsLayout`; both call sites
  // (the dashboard, src/app/(app)/page.tsx, and the Documents list,
  // src/app/(app)/quotes/page.tsx) post this action directly. Calling the
  // same guard here is what makes a region-less manager land on /no-region
  // by either route instead of on the error boundary.
  const { session } = await requireRegion();

  // Deliberately `session.user.regionId` rather than `requireRegion`'s
  // returned `regionId`: for a MANAGER the two are equal, and for an ADMIN
  // the return is `null` (meaning "may read every region"), which is not an
  // answer to "which region does a quote this person authors belong to".
  // That is always their own.
  const authorRegionId = session.user.regionId;
  if (!authorRegionId) {
    // Only an ADMIN reaches this: `requireRegion` already redirected any
    // manager without a region. The message is theirs to act on, and it
    // differs from REGION_REQUIRED_ERROR because "contact your
    // administrator" is nonsense advice to the administrator.
    throw new Error(
      "Your account has no region, so there is no region to create this quote in. Set one on your user in Settings."
    );
  }
  const resolvedRegion = await db.region.findUnique({ where: { id: authorRegionId } });
  if (!resolvedRegion) {
    throw new Error(REGION_REQUIRED_ERROR);
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
  redirect(`/quotes/${created.id}`);
}

/**
 * Deletes a DRAFT document (items/lines cascade — see schema). Scoped to
 * the caller and restricted to DRAFT status: a FINAL document is never
 * deletable through this action.
 *
 * Returns only the failure half of `ActionResult`. A successful delete ends
 * in `redirect`, which does not return — it throws a redirect error Next
 * catches at the action boundary and turns into a navigation — so the `{}`
 * an `ActionResult` promises on success is a value no caller can ever
 * observe. Narrowing the type to `{ error: string }` says so, while leaving
 * the handled-failure returns above reaching the caller exactly as before;
 * `redirect`'s own `never` return is what lets an async function declared
 * this way end without a `return`. The one call site, `DeleteDraftButton`,
 * already reads the result as `result?.error` and renders nothing on the
 * success path, so it needs no change — it simply stops branching on a shape
 * that could not arrive.
 */
export async function deleteDraft(documentId: string): Promise<{ error: string }> {
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
  redirect("/quotes");
}

/**
 * Permanently deletes a document of any status, from the /quotes list.
 * Items/lines cascade via `onDelete: Cascade` (schema.prisma) -- and so, for
 * a signed quote, would its `Signature` and `SigningRequest` rows, leaving
 * the archived PDF (`Document.signedPdfSha256`) on disk referenced by
 * nothing. `canDeleteDocument` (src/lib/signing/state.ts) exists to stop
 * that: it is checked first, before the FINAL/admin rule below, so a signed
 * quote is refused with the accurate reason rather than "only an admin can
 * delete a finalized document" -- advice that would send a manager looking
 * for an admin who, being subject to the same signed-quote rule, could not
 * do it either.
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
    select: { id: true, status: true, signingStatus: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const deletable = canDeleteDocument(document.signingStatus);
  if (!deletable.ok) return { error: deletable.reason };

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
