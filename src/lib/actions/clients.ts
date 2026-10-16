"use server";

import { revalidateCompany, revalidateCompanyList, revalidateDocument } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { recalcDocument } from "@/lib/documents/recalc";
import { requireSession } from "@/lib/authz";
import { companyOwnedWhereForUser, companyWhereForUser, documentWhereForUser } from "@/lib/scope";
import { companySchema, contactSchema } from "@/lib/validation/clients";
import { idSchema } from "@/lib/validation/documents";
import { NOT_FOUND_ERROR, flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

// --- shared helpers ----------------------------------------------------

function readCompanyForm(formData: FormData) {
  return {
    name: formData.get("name"),
    street: formData.get("street"),
    city: formData.get("city"),
    state: formData.get("state"),
    postcode: formData.get("postcode"),
    country: formData.get("country"),
    website: formData.get("website"),
    taxId: formData.get("taxId"),
    notes: formData.get("notes"),
    // `FormData.get` returns the FIRST value for a repeated name — see
    // CompanyForm's doc comment for why the checkbox is listed before its
    // hidden "false" fallback, so this returns "true" only when checked.
    deliverySameAsMain: formData.get("deliverySameAsMain"),
    deliveryStreet: formData.get("deliveryStreet"),
    deliveryCity: formData.get("deliveryCity"),
    deliveryState: formData.get("deliveryState"),
    deliveryPostcode: formData.get("deliveryPostcode"),
    deliveryCountry: formData.get("deliveryCountry"),
    deliveryContactName: formData.get("deliveryContactName"),
    deliveryPhone: formData.get("deliveryPhone"),
    deliveryNotes: formData.get("deliveryNotes"),
    // `get` returns null for a missing field; map that to `undefined` so a
    // form without the industry input (the edit screen, whose picker saves
    // on its own) leaves the stored value alone — see `industryIdSchema`.
    industryId: formData.has("industryId") ? formData.get("industryId") : undefined,
  };
}

/**
 * Whether a parsed `industryId` is usable: `undefined`/`null` always are, an
 * id only when the row exists. Checked before the write so a stale or forged
 * id is a form error rather than a foreign-key exception.
 */
async function industryExists(industryId: string | null | undefined): Promise<boolean> {
  if (!industryId) return true;
  const industry = await db.industry.findUnique({ where: { id: industryId }, select: { id: true } });
  return industry !== null;
}

const UNKNOWN_INDUSTRY_ERROR = "That industry no longer exists. Pick another one.";

function readContactForm(formData: FormData) {
  return {
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    position: formData.get("position"),
    isPrimary: formData.get("isPrimary"),
  };
}

// --- companies -----------------------------------------------------------

/**
 * Creates a company owned by the current session's user — managers create
 * their own clients; an admin who creates one also becomes its owner (they
 * can see and edit every company regardless, via companyWhereForUser).
 *
 * No region is involved: a company belongs to the business, not to an
 * office, so there is nothing here for `assertRegionWritable` to guard.
 * Ownership (`companyWhereForUser`) is what scopes a company; region still
 * guards the things that genuinely are per-office — prices, and the
 * currency/tax/caps a Document carries.
 */
export async function createCompany(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsed = companySchema.safeParse(readCompanyForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }
  if (!(await industryExists(parsed.data.industryId))) {
    return { error: UNKNOWN_INDUSTRY_ERROR };
  }

  const created = await db.company.create({
    data: {
      name: parsed.data.name,
      industryId: parsed.data.industryId ?? null,
      street: parsed.data.street ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      postcode: parsed.data.postcode ?? null,
      country: parsed.data.country ?? null,
      website: parsed.data.website ?? null,
      taxId: parsed.data.taxId ?? null,
      notes: parsed.data.notes ?? null,
      ownerId: session.user.id,
      deliverySameAsMain: parsed.data.deliverySameAsMain,
      deliveryStreet: parsed.data.deliveryStreet ?? null,
      deliveryCity: parsed.data.deliveryCity ?? null,
      deliveryState: parsed.data.deliveryState ?? null,
      deliveryPostcode: parsed.data.deliveryPostcode ?? null,
      deliveryCountry: parsed.data.deliveryCountry ?? null,
      deliveryContactName: parsed.data.deliveryContactName ?? null,
      deliveryPhone: parsed.data.deliveryPhone ?? null,
      deliveryNotes: parsed.data.deliveryNotes ?? null,
    },
  });

  revalidateCompanyList();
  redirect(`/clients/${created.id}`);
}

export async function updateCompany(companyId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(companyId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  const parsed = companySchema.safeParse(readCompanyForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const existing = await db.company.findFirst({
    where: { id: companyId, ...companyWhereForUser(session.user) },
  });
  if (!existing) return { error: NOT_FOUND_ERROR };
  if (!(await industryExists(parsed.data.industryId))) {
    return { error: UNKNOWN_INDUSTRY_ERROR };
  }

  await db.company.update({
    where: { id: companyId },
    data: {
      name: parsed.data.name,
      // Absent means "unchanged" (see `readCompanyForm`).
      ...(parsed.data.industryId !== undefined ? { industryId: parsed.data.industryId } : {}),
      street: parsed.data.street ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      postcode: parsed.data.postcode ?? null,
      country: parsed.data.country ?? null,
      website: parsed.data.website ?? null,
      taxId: parsed.data.taxId ?? null,
      notes: parsed.data.notes ?? null,
      deliverySameAsMain: parsed.data.deliverySameAsMain,
      deliveryStreet: parsed.data.deliveryStreet ?? null,
      deliveryCity: parsed.data.deliveryCity ?? null,
      deliveryState: parsed.data.deliveryState ?? null,
      deliveryPostcode: parsed.data.deliveryPostcode ?? null,
      deliveryCountry: parsed.data.deliveryCountry ?? null,
      deliveryContactName: parsed.data.deliveryContactName ?? null,
      deliveryPhone: parsed.data.deliveryPhone ?? null,
      deliveryNotes: parsed.data.deliveryNotes ?? null,
    },
  });

  // Country, delivery country and VAT ID drive every open quote's suggested
  // tax, so a change to any of them re-prices the company's open drafts.
  // Nothing else on this form reaches the tax, and a recalc touches
  // `Document.updatedAt` (which orders the quote list), so an edit that
  // leaves all four alone must not recalc. FINAL quotes are frozen and a
  // Custom-tax draft keeps its figures, so both are filtered out up front.
  const norm = (value: string | null | undefined) => (value ?? "").trim();
  const taxInputsChanged =
    norm(existing.country) !== norm(parsed.data.country) ||
    existing.deliverySameAsMain !== parsed.data.deliverySameAsMain ||
    norm(existing.deliveryCountry) !== norm(parsed.data.deliveryCountry) ||
    norm(existing.taxId) !== norm(parsed.data.taxId);
  if (taxInputsChanged) {
    const drafts = await db.document.findMany({
      where: { companyId, status: "DRAFT", taxOverridden: false },
      select: { id: true },
    });
    for (const draft of drafts) {
      // One draft failing must not leave the rest on a stale tax.
      try {
        await recalcDocument(draft.id);
        revalidateDocument(draft.id);
      } catch (error) {
        console.error(`Failed to re-price draft ${draft.id} after company ${companyId} changed`, error);
      }
    }
  }

  revalidateCompanyList();
  revalidateCompany(companyId);
  return {};
}

export async function deleteCompany(companyId: string): Promise<ActionResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(companyId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  // Deliberately NOT `companyWhereForUser`, which is what every other action
  // in this file uses. A country grant lets a manager see and edit the
  // imported clients; it must not let them delete one they do not own.
  // Deleting is irreversible and the quote-less imported companies are the
  // ones the quote check below does not protect. See the header of
  // src/lib/scope.ts (decision D2). Do not "fix" this to match its siblings.
  const existing = await db.company.findFirst({
    where: { id: companyId, ...companyOwnedWhereForUser(session.user) },
  });
  if (!existing) return { error: NOT_FOUND_ERROR };

  const documentCount = await db.document.count({ where: { companyId } });
  if (documentCount > 0) {
    return { error: "This company has quotes and can't be deleted." };
  }

  // Contact rows cascade (Contact.companyId is onDelete: Cascade in the schema).
  await db.company.delete({ where: { id: companyId } });

  revalidateCompanyList();
  redirect("/clients");
}

// --- contacts --------------------------------------------------------------

/**
 * Creates a contact under `companyId`, scope-checked through the parent
 * company. Marking it primary clears every other contact's primary flag on
 * the same company in one transaction, so at most one contact per company
 * is ever primary.
 */
export async function createContact(companyId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(companyId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  const company = await db.company.findFirst({
    where: { id: companyId, ...companyWhereForUser(session.user) },
  });
  if (!company) return { error: NOT_FOUND_ERROR };

  const parsed = contactSchema.safeParse(readContactForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  await db.$transaction(async (tx) => {
    if (parsed.data.isPrimary) {
      await tx.contact.updateMany({
        where: { companyId: company.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    await tx.contact.create({
      data: {
        companyId: company.id,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName ?? null,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        position: parsed.data.position ?? null,
        isPrimary: parsed.data.isPrimary,
      },
    });
  });

  revalidateCompany(company.id);
  return {};
}

export async function updateContact(contactId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(contactId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  const existing = await db.contact.findFirst({
    where: { id: contactId, company: companyWhereForUser(session.user) },
  });
  if (!existing) return { error: NOT_FOUND_ERROR };

  const parsed = contactSchema.safeParse(readContactForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  await db.$transaction(async (tx) => {
    if (parsed.data.isPrimary) {
      await tx.contact.updateMany({
        where: { companyId: existing.companyId, id: { not: contactId }, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    await tx.contact.update({
      where: { id: contactId },
      data: {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName ?? null,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        position: parsed.data.position ?? null,
        isPrimary: parsed.data.isPrimary,
      },
    });
  });

  revalidateCompany(existing.companyId);
  return {};
}

export async function deleteContact(contactId: string): Promise<ActionResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(contactId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  // Deliberately NOT `companyWhereForUser` (which `updateContact` above
  // uses): a contact is deleted under the same narrow rule as its company, so
  // a country grant cannot be used to strip a client of its contacts when it
  // cannot delete the client. See the header of src/lib/scope.ts (decision
  // D2). Do not "fix" this to match its siblings.
  const existing = await db.contact.findFirst({
    where: { id: contactId, company: companyOwnedWhereForUser(session.user) },
  });
  if (!existing) return { error: NOT_FOUND_ERROR };

  await db.contact.delete({ where: { id: contactId } });

  revalidateCompany(existing.companyId);
  return {};
}

// --- inline creation (document builder) -----------------------------------
//
// JSON-friendly siblings of createCompany/createContact for the document
// builder's inline "+ New company" / "+ New contact" panels
// (src/components/builder/client-section.tsx): plain-object input instead
// of FormData, and the created entity is RETURNED instead of redirecting,
// so the builder can select it without ever leaving the page. Validation and
// scope rules are shared with the form actions above (same zod schemas, same
// companyWhereForUser) — the two stay in sync by construction.
//
// A new company is also put ON the draft by `createCompanyInline` itself when
// the builder passes the draft's id: one round trip for one intent, where
// the builder used to follow the create with a separate `setDocumentClient`
// call (two POSTs, two re-renders of the page). A new contact still goes
// through `setDocumentClient` from the builder, since it may be chosen for a
// company that is already on the quote.

export type CompanyInlineInput = {
  name: string;
  website?: string;
  street?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  taxId?: string;
  deliverySameAsMain?: boolean;
  deliveryStreet?: string;
  deliveryCity?: string;
  deliveryState?: string;
  deliveryPostcode?: string;
  deliveryCountry?: string;
  deliveryContactName?: string;
  deliveryPhone?: string;
  /** An existing Industry id, or null/"" for none. */
  industryId?: string | null;
};

export type CreateCompanyInlineResult =
  | { ok: true; company: { id: string; name: string } }
  | { error: string };

/** Thrown inside `createCompanyInline`'s transaction when the draft it was
 * asked to put the company on turned out not to be a draft any more (or to
 * be gone), so the company's creation rolls back with it. Reported to the
 * caller as the same `NOT_FOUND_ERROR` `setDocumentClient` gives for a
 * document that is no longer editable. */
class DraftGoneError extends Error {}

/**
 * Creates a company owned by the current session's user (same ownership
 * rule as `createCompany`). `notes` isn't collectable from the inline
 * panel — it's deliberately short; a manager who needs it uses the full
 * /clients/new form or edits the company afterwards from /clients.
 *
 * With `documentId` -- the builder always passes its draft's -- the new
 * company is also made that draft's client, in the same transaction as its
 * creation, doing what `setDocumentClient` would: the draft gets the
 * company, its contact is whatever the company's primary contact is (nothing
 * -- the company is seconds old and has none), and the quote is re-priced,
 * because the client's country moves the suggested tax. One statement folds
 * the DRAFT check into the write (`updateMany` scoped to `status: "DRAFT"`
 * and to the caller, reading `count !== 1` as "gone or no longer a draft"),
 * the same atomic form the document actions use for a single-statement
 * write, so a Finalize landing between the pre-read and this write rolls the
 * whole thing back -- the company included, rather than leaving a new client
 * that was never put on anything. The pre-read makes that the race only:
 * a stale tab is told "Not found" before any company is created.
 */
export async function createCompanyInline(
  input: CompanyInlineInput,
  documentId?: string | null
): Promise<CreateCompanyInlineResult> {
  const session = await requireSession();

  const parsed = companySchema.safeParse(input);
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }
  if (!(await industryExists(parsed.data.industryId))) {
    return { error: UNKNOWN_INDUSTRY_ERROR };
  }

  // The draft to put the company on, checked the way `setDocumentClient`
  // checks it before writing: it exists, it is this caller's to edit, and it
  // is still a draft. `null` when the caller asked for no assignment.
  let draftId: string | null = null;
  if (documentId) {
    const parsedDocumentId = idSchema.safeParse(documentId);
    if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };
    const draft = await db.document.findFirst({
      where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
      select: { id: true },
    });
    if (!draft) return { error: NOT_FOUND_ERROR };
    draftId = draft.id;
  }

  const data = {
    name: parsed.data.name,
    industryId: parsed.data.industryId ?? null,
    street: parsed.data.street ?? null,
    city: parsed.data.city ?? null,
    state: parsed.data.state ?? null,
    postcode: parsed.data.postcode ?? null,
    country: parsed.data.country ?? null,
    website: parsed.data.website ?? null,
    taxId: parsed.data.taxId ?? null,
    notes: null,
    ownerId: session.user.id,
    deliverySameAsMain: parsed.data.deliverySameAsMain,
    deliveryStreet: parsed.data.deliveryStreet ?? null,
    deliveryCity: parsed.data.deliveryCity ?? null,
    deliveryState: parsed.data.deliveryState ?? null,
    deliveryPostcode: parsed.data.deliveryPostcode ?? null,
    deliveryCountry: parsed.data.deliveryCountry ?? null,
    deliveryContactName: parsed.data.deliveryContactName ?? null,
    deliveryPhone: parsed.data.deliveryPhone ?? null,
    deliveryNotes: parsed.data.deliveryNotes ?? null,
  };

  let created: { id: string; name: string };
  try {
    created = await db.$transaction(async (tx) => {
      const company = await tx.company.create({ data, select: { id: true, name: true } });
      if (draftId) {
        // `contactId: null` is what `setDocumentClient`'s primary-contact
        // resolution yields for a company with no contacts, which a company
        // created in this very transaction necessarily is.
        const guarded = await tx.document.updateMany({
          where: { id: draftId, status: "DRAFT" },
          data: { companyId: company.id, contactId: null },
        });
        if (guarded.count !== 1) throw new DraftGoneError();
        // The client decides the destination country and VAT ID the tax
        // suggestion reads, so the quote is re-priced here, in the same
        // transaction, exactly as `setDocumentClient` does. Pre-tax totals
        // are untouched, so neither recalc cap can trip.
        await recalcDocument(draftId, tx);
      }
      return company;
    });
  } catch (error) {
    if (error instanceof DraftGoneError) return { error: NOT_FOUND_ERROR };
    throw error;
  }

  revalidateCompanyList();
  if (draftId) revalidateDocument(draftId);
  return { ok: true, company: { id: created.id, name: created.name } };
}

export type ContactInlineInput = {
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  position?: string;
};

export type CreateContactInlineResult =
  | { ok: true; contact: { id: string; label: string } }
  | { error: string };

/**
 * Creates a contact under `companyId`, scope-checked through the parent
 * company exactly like `createContact`. The inline panel has no
 * "Primary contact" checkbox (there's no meaningful choice yet on a
 * brand-new company) — instead the FIRST contact ever created for a
 * company is automatically made primary, so `setDocumentClient`'s
 * auto-primary resolution (see src/lib/actions/documents.ts) has
 * something to pick up the moment this contact is chosen.
 */
export async function createContactInline(
  companyId: string,
  input: ContactInlineInput
): Promise<CreateContactInlineResult> {
  const session = await requireSession();

  const idParsed = idSchema.safeParse(companyId);
  if (!idParsed.success) {
    return { error: NOT_FOUND_ERROR };
  }

  const company = await db.company.findFirst({
    where: { id: companyId, ...companyWhereForUser(session.user) },
  });
  if (!company) return { error: NOT_FOUND_ERROR };

  const existingContactCount = await db.contact.count({ where: { companyId: company.id } });
  const isPrimary = existingContactCount === 0;

  const parsed = contactSchema.safeParse({ ...input, isPrimary });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const created = await db.$transaction(async (tx) => {
    if (parsed.data.isPrimary) {
      await tx.contact.updateMany({
        where: { companyId: company.id, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return tx.contact.create({
      data: {
        companyId: company.id,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName ?? null,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        position: parsed.data.position ?? null,
        isPrimary: parsed.data.isPrimary,
      },
    });
  });

  revalidateCompany(company.id);
  const label = [created.firstName, created.lastName].filter(Boolean).join(" ");
  return { ok: true, contact: { id: created.id, label } };
}
