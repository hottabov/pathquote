"use client";

import { useMemo, useState, useTransition } from "react";
import { Building2, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import {
  CompanyDeliverySameAsMainField,
  CompanyField,
  CompanyRegionField,
  emptyCompanyFields,
  type CompanyFieldBinding,
  type CompanyFieldValues,
  type RegionOption,
} from "@/components/clients/company-fields";
import {
  ContactFields,
  EMPTY_CONTACT_FIELDS,
  type ContactFieldValues,
} from "@/components/clients/contact-fields";
import { cn } from "@/lib/utils";
import { setDocumentClient } from "@/lib/actions/documents";
import { createCompanyInline, createContactInline } from "@/lib/actions/clients";
import type { ClientPickerCompany } from "@/lib/queries/documents";

export type { RegionOption };

/**
 * The builder's "Client" section: a search box over every company `user`
 * can see (preloaded in full server-side — companies are a small list, so a
 * client-side filter is simpler than a per-keystroke server round trip),
 * then a company select and — once a company with contacts is chosen — a
 * contact select. Every change calls `setDocumentClient` directly (no
 * <form>, same pattern as the "make primary" star in
 * src/components/clients/contacts-section.tsx) so picking a client is a
 * single tap with no separate "save" step. Once a company is selected it
 * collapses to a small summary card with a "Change" action, so the picker
 * itself only reappears when actually switching clients.
 *
 * "+ New company" / "+ New contact" open an inline panel right here
 * (`createCompanyInline`/`createContactInline` — the JSON-friendly siblings
 * of the /clients forms' actions, see src/lib/actions/clients.ts) instead of
 * navigating to /clients/new: a
 * manager building a quote for a client that doesn't exist yet never has
 * to leave the document. On success the new entity is appended to the
 * local company list (kept in state precisely so this doesn't need a
 * server round trip to reflect), auto-selected, and immediately applied
 * to the document via `setDocumentClient` — same as picking an existing
 * company/contact from the selects. These two panels keep an explicit
 * "Create" button (creation is an intentional trigger, unlike an edit) —
 * everything else in the builder that got autosaved keeps that button
 * gone (see item-discount-field.tsx, document-discount-field.tsx,
 * notes-section.tsx).
 *
 * Both panels render the same field components the standalone /clients forms
 * do (`@/components/clients/company-fields` and `.../contact-fields`) — only
 * the layout and the submission mechanics are this file's own, which is the
 * whole of what actually differs between the two screens.
 */
export function ClientSection({
  documentId,
  companies,
  initialCompanyId,
  initialContactId,
  regions,
  defaultRegionCode,
  readOnly = false,
}: {
  documentId: string;
  companies: ClientPickerCompany[];
  initialCompanyId: string | null;
  initialContactId: string | null;
  regions: RegionOption[];
  defaultRegionCode: string;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [localCompanies, setLocalCompanies] = useState<ClientPickerCompany[]>(companies);
  const [query, setQuery] = useState("");
  const [companyId, setCompanyId] = useState(initialCompanyId ?? "");
  const [contactId, setContactId] = useState(initialContactId ?? "");
  const [picking, setPicking] = useState(!initialCompanyId);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [showMoreCompanyFields, setShowMoreCompanyFields] = useState(false);
  const [companyForm, setCompanyForm] = useState<CompanyFieldValues>(() =>
    emptyCompanyFields(defaultRegionCode)
  );
  const [companyFormPending, setCompanyFormPending] = useState(false);
  const [companyFormError, setCompanyFormError] = useState<string | null>(null);

  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState<ContactFieldValues>(EMPTY_CONTACT_FIELDS);
  const [contactFormPending, setContactFormPending] = useState(false);
  const [contactFormError, setContactFormError] = useState<string | null>(null);

  function setCompanyField<K extends keyof CompanyFieldValues>(
    field: K,
    value: CompanyFieldValues[K]
  ) {
    setCompanyForm((current) => ({ ...current, [field]: value }));
  }

  function setContactField<K extends keyof ContactFieldValues>(
    field: K,
    value: ContactFieldValues[K]
  ) {
    setContactForm((current) => ({ ...current, [field]: value }));
  }

  const companyBinding: CompanyFieldBinding = {
    values: companyForm,
    set: setCompanyField,
    idPrefix: "inline-company",
    named: false,
    disabled: companyFormPending,
  };

  const filteredCompanies = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return localCompanies;
    return localCompanies.filter((c) => c.name.toLowerCase().includes(term));
  }, [localCompanies, query]);

  const selectedCompany = localCompanies.find((c) => c.id === companyId) ?? null;

  function runSetClient(nextCompanyId: string, nextContactId: string) {
    setError(null);
    startTransition(async () => {
      const result = await setDocumentClient(documentId, nextCompanyId, nextContactId || null);
      if (result?.error) setError(result.error);
    });
  }

  function handleCompanyChange(nextCompanyId: string) {
    setCompanyId(nextCompanyId);
    // Mirror the server's auto-primary-contact resolution (setDocumentClient)
    // for an immediate UI reflection: `contacts` is already ordered isPrimary
    // desc, firstName asc (see listClientPickerCompanies), so [0] is exactly
    // the contact the server will assign when no contactId is submitted.
    const nextCompany = localCompanies.find((c) => c.id === nextCompanyId) ?? null;
    const autoContactId = nextCompany?.contacts[0]?.id ?? "";
    setContactId(autoContactId);
    if (nextCompanyId) {
      runSetClient(nextCompanyId, "");
      setPicking(false);
      setQuery("");
      setShowContactForm(false);
    }
  }

  function handleContactChange(nextContactId: string) {
    setContactId(nextContactId);
    if (companyId) runSetClient(companyId, nextContactId);
  }

  function closeCompanyForm() {
    setShowCompanyForm(false);
    setCompanyFormError(null);
    setCompanyForm(emptyCompanyFields(defaultRegionCode));
    setShowMoreCompanyFields(false);
  }

  function closeContactForm() {
    setShowContactForm(false);
    setContactFormError(null);
    setContactForm(EMPTY_CONTACT_FIELDS);
  }

  async function handleCreateCompany() {
    setCompanyFormError(null);
    setCompanyFormPending(true);
    // `CompanyFieldValues` and `CompanyInlineInput` carry the same fields
    // under the same names, so the whole form goes over as-is.
    const result = await createCompanyInline(companyForm);
    setCompanyFormPending(false);

    if ("error" in result) {
      setCompanyFormError(result.error);
      return;
    }

    const newCompany: ClientPickerCompany = { id: result.company.id, name: result.company.name, contacts: [] };
    setLocalCompanies((prev) => [...prev, newCompany].sort((a, b) => a.name.localeCompare(b.name)));
    setCompanyId(result.company.id);
    setContactId("");
    setPicking(false);
    setQuery("");
    closeCompanyForm();
    runSetClient(result.company.id, "");
    toast.success(`${result.company.name} created`);
  }

  async function handleCreateContact() {
    if (!companyId) return;
    setContactFormError(null);
    setContactFormPending(true);
    const result = await createContactInline(companyId, contactForm);
    setContactFormPending(false);

    if ("error" in result) {
      setContactFormError(result.error);
      return;
    }

    const trimmedFirstName = contactForm.firstName.trim();
    const trimmedLastName = contactForm.lastName.trim();
    setLocalCompanies((prev) =>
      prev.map((c) =>
        c.id === companyId
          ? {
              ...c,
              contacts: [
                ...c.contacts,
                {
                  id: result.contact.id,
                  firstName: trimmedFirstName,
                  lastName: trimmedLastName || null,
                  isPrimary: c.contacts.length === 0,
                },
              ],
            }
          : c
      )
    );
    setContactId(result.contact.id);
    closeContactForm();
    runSetClient(companyId, result.contact.id);
    toast.success(`${result.contact.label} created`);
  }

  return (
    <SectionCard
      title="Client"
      actions={
        !readOnly ? (
          <button
            type="button"
            onClick={() => (showCompanyForm ? closeCompanyForm() : setShowCompanyForm(true))}
            disabled={pending}
            className="focus-ring rounded-md text-xs font-medium text-brand hover:underline"
          >
            {showCompanyForm ? "Cancel" : "+ New company"}
          </button>
        ) : undefined
      }
    >
      {readOnly ? (
        <p className="text-sm text-slate-700">{selectedCompany?.name ?? "No client set"}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {selectedCompany && !picking ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Building2 className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-brand-dark">{selectedCompany.name}</p>
                  <p className="text-xs text-slate-500">
                    {selectedCompany.contacts.length === 0
                      ? "No contacts on file"
                      : `${selectedCompany.contacts.length} contact${selectedCompany.contacts.length === 1 ? "" : "s"}`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPicking(true)}
                disabled={pending}
                className="focus-ring shrink-0 rounded-md text-xs font-medium text-brand hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search companies…"
                  aria-label="Search companies"
                  className={cn(fieldInputClass, "pl-9")}
                  disabled={pending}
                />
              </div>

              <select
                aria-label="Company"
                value={companyId}
                onChange={(e) => handleCompanyChange(e.target.value)}
                className={fieldInputClass}
                disabled={pending}
              >
                <option value="">Select a company…</option>
                {filteredCompanies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showCompanyForm ? (
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CompanyField binding={companyBinding} field="name" required />
                <CompanyRegionField binding={companyBinding} regions={regions} required />
                <CompanyField binding={companyBinding} field="city" />
                <CompanyField binding={companyBinding} field="country" />
                <CompanyField binding={companyBinding} field="website" className="sm:col-span-2" />
              </div>

              <button
                type="button"
                onClick={() => setShowMoreCompanyFields((s) => !s)}
                className="focus-ring w-fit text-xs font-medium text-brand hover:underline"
              >
                {showMoreCompanyFields ? "Fewer fields" : "More fields"}
              </button>

              {showMoreCompanyFields ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <CompanyField binding={companyBinding} field="street" />
                  <CompanyField binding={companyBinding} field="state" />
                  <CompanyField binding={companyBinding} field="postcode" />
                  <CompanyField binding={companyBinding} field="taxId" />

                  <CompanyDeliverySameAsMainField
                    binding={companyBinding}
                    label="Delivery address same as main address"
                    className="flex min-h-11 items-center gap-2 text-sm font-medium text-brand-dark sm:col-span-2"
                  />

                  {!companyForm.deliverySameAsMain ? (
                    <>
                      <CompanyField binding={companyBinding} field="deliveryStreet" required />
                      <CompanyField binding={companyBinding} field="deliveryCity" required />
                      <CompanyField binding={companyBinding} field="deliveryState" />
                      <CompanyField binding={companyBinding} field="deliveryPostcode" required />
                      <CompanyField binding={companyBinding} field="deliveryCountry" required />
                      <CompanyField
                        binding={companyBinding}
                        field="deliveryContactName"
                        label="Delivery contact"
                      />
                      <CompanyField
                        binding={companyBinding}
                        field="deliveryPhone"
                        className="sm:col-span-2"
                      />
                    </>
                  ) : null}
                </div>
              ) : null}

              {companyFormError ? (
                <p role="alert" className="text-sm text-destructive">
                  {companyFormError}
                </p>
              ) : null}

              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={handleCreateCompany}
                  disabled={companyFormPending || !companyForm.name.trim() || !companyForm.regionCode}
                  className="h-11 bg-brand text-white hover:bg-brand/90 sm:h-9"
                >
                  {companyFormPending ? "Creating…" : "Create company"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeCompanyForm}
                  disabled={companyFormPending}
                  className="h-11 sm:h-9"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {selectedCompany && !picking ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-brand-dark">Contact</span>
                <button
                  type="button"
                  onClick={() => (showContactForm ? closeContactForm() : setShowContactForm(true))}
                  disabled={pending}
                  className="focus-ring flex items-center gap-1 rounded-md text-xs font-medium text-brand hover:underline"
                >
                  <UserPlus className="size-3.5" aria-hidden="true" />
                  {showContactForm ? "Cancel" : "New contact"}
                </button>
              </div>

              {selectedCompany.contacts.length > 0 ? (
                <select
                  aria-label="Contact"
                  value={contactId}
                  onChange={(e) => handleContactChange(e.target.value)}
                  className={fieldInputClass}
                  disabled={pending}
                >
                  <option value="">No contact selected</option>
                  {selectedCompany.contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {[contact.firstName, contact.lastName].filter(Boolean).join(" ")}
                      {contact.isPrimary ? " (primary)" : ""}
                    </option>
                  ))}
                </select>
              ) : !showContactForm ? (
                <p className="text-xs text-slate-500">No contacts on file yet.</p>
              ) : null}

              {showContactForm ? (
                <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                  <ContactFields
                    values={contactForm}
                    set={setContactField}
                    idPrefix="inline-contact"
                    named={false}
                    disabled={contactFormPending}
                  />

                  {contactFormError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {contactFormError}
                    </p>
                  ) : null}

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      onClick={handleCreateContact}
                      disabled={contactFormPending || !contactForm.firstName.trim()}
                      className="h-11 bg-brand text-white hover:bg-brand/90 sm:h-9"
                    >
                      {contactFormPending ? "Creating…" : "Create contact"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={closeContactForm}
                      disabled={contactFormPending}
                      className="h-11 sm:h-9"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
