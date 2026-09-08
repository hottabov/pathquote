"use server";

import { revalidateCompany, revalidateCompanyList } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { companyWhereForUser } from "@/lib/scope";
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
  };
}

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

  const created = await db.company.create({
    data: {
      name: parsed.data.name,
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

  await db.company.update({
    where: { id: companyId },
    data: {
      name: parsed.data.name,
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

  const existing = await db.company.findFirst({
    where: { id: companyId, ...companyWhereForUser(session.user) },
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

  const existing = await db.contact.findFirst({
    where: { id: contactId, company: companyWhereForUser(session.user) },
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
// so the builder can select it and call setDocumentClient without ever
// leaving the page. Validation and scope rules are shared with the form
// actions above (same zod schemas, same companyWhereForUser) — the two
// stay in sync by construction.

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
};

export type CreateCompanyInlineResult =
  | { ok: true; company: { id: string; name: string } }
  | { error: string };

/**
 * Creates a company owned by the current session's user (same ownership
 * rule as `createCompany`). `notes` isn't collectable from the inline
 * panel — it's deliberately short; a manager who needs it uses the full
 * /clients/new form or edits the company afterwards from /clients.
 */
export async function createCompanyInline(input: CompanyInlineInput): Promise<CreateCompanyInlineResult> {
  const session = await requireSession();

  const parsed = companySchema.safeParse(input);
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const created = await db.company.create({
    data: {
      name: parsed.data.name,
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
    },
  });

  revalidateCompanyList();
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
