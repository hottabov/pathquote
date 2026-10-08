"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Building2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, FieldRow, ReadOnlyValue, SectionCard, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { ClientCombobox } from "@/components/builder/client-combobox";
import {
  CompanyDeliverySameAsMainField,
  CompanyField,
  emptyCompanyFields,
  type CompanyFieldBinding,
  type CompanyFieldValues,
} from "@/components/clients/company-fields";
import {
  ContactFields,
  EMPTY_CONTACT_FIELDS,
  type ContactFieldValues,
} from "@/components/clients/contact-fields";
import { IndustryPicker, type IndustryOption } from "@/components/clients/industry-picker";
import { setDocumentClient } from "@/lib/actions/documents";
import { createCompanyInline, createContactInline } from "@/lib/actions/clients";
import { clientLocation } from "@/lib/client-search";
import type { ClientSearchCompany } from "@/lib/queries/client-search";

/**
 * The builder's "Client" section: a company combobox (`ClientCombobox` — one
 * search box that opens a list of the newest companies on focus and narrows
 * it as you type) and — once a company with contacts is chosen — a contact
 * select. Every change calls `setDocumentClient` directly (no <form>, same
 * pattern as the "make primary" star in
 * src/components/clients/contacts-section.tsx) so picking a client is a
 * single tap with no separate "save" step. Once a company is selected it
 * collapses to a small summary card with a "Change" action, so the picker
 * itself only reappears when actually switching clients. Choosing a company
 * unmounts the combobox, so focus is moved to "Change" rather than left to
 * fall to the page.
 *
 * THE SEARCH IS SERVER-SIDE, AND THAT IS NOT AN OPTIMISATION TO UNDO: the page
 * passes only the quote's own company (`initialCompany`) and the combobox asks
 * `searchClients` for up to `CLIENT_SEARCH_PAGE_SIZE` more as the manager
 * types. The 8,810-company, 2,158 kB reasoning is in client-combobox.tsx. Do
 * not put the full list back, however convenient the instant filter was.
 *
 * One consequence this file is built around: the selected company is held as
 * an object of its own, not looked up in the current results. Results are
 * replaced on every search, so a lookup would lose the selection the moment
 * the manager searched again after picking.
 *
 * "+ New company" / "+ New contact" open an inline panel right here
 * (`createCompanyInline`/`createContactInline` — the JSON-friendly siblings
 * of the /clients forms' actions, see src/lib/actions/clients.ts) instead of
 * navigating to /clients/new: a
 * manager building a quote for a client that doesn't exist yet never has
 * to leave the document. On success the new entity is made the selected
 * company directly from what the action returned — no search round trip to
 * find it again — and immediately applied to the document via
 * `setDocumentClient`, same as picking an existing company/contact from the
 * selects. These two panels keep an explicit
 * "Create" button (creation is an intentional trigger, unlike an edit) —
 * everything else in the builder that got autosaved keeps that button
 * gone (see item-discount-field.tsx, document-discount-field.tsx,
 * notes-section.tsx).
 *
 * Both panels render the same field components the standalone /clients forms
 * do (`@/components/clients/company-fields` and `.../contact-fields`) — only
 * the layout and the submission mechanics are this file's own, which is the
 * whole of what actually differs between the two screens.
 *
 * Industry (printed on the production order forms) belongs to the company,
 * so the builder has no field of its own for it once a client is picked —
 * it is edited on the company card at /clients. The "+ New company" panel
 * still offers it, since that panel *is* the company card for a company
 * that doesn't exist yet; creating a new industry stays on
 * /settings/industries.
 */
export function ClientSection({
  documentId,
  initialCompany,
  industries,
  initialContactId,
  readOnly = false,
}: {
  documentId: string;
  /** The quote's own company, with its contacts ordered `isPrimary` desc then
   * `firstName` asc, or null when it has none yet. The only company this
   * component is handed: every other one comes from the search. */
  initialCompany: ClientSearchCompany | null;
  /** The shared Industry list, for the "+ New company" panel's picker. */
  industries: IndustryOption[];
  initialContactId: string | null;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [selectedCompany, setSelectedCompany] = useState<ClientSearchCompany | null>(initialCompany);
  const [contactId, setContactId] = useState(initialContactId ?? "");
  const [picking, setPicking] = useState(!initialCompany);
  // Whether the picker opened because "Change" was pressed, in which case it
  // takes focus (and so opens its list); a page that loads with no client yet
  // does not grab it.
  const [focusPicker, setFocusPicker] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Choosing a company swaps the combobox for the summary card, unmounting the
  // control that had focus. Focus is handed to "Change" -- the card's one
  // control and the way back to the picker -- instead of being dropped on the
  // page. Set by what picks a company, acted on once the card is on screen.
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const refocusChange = useRef(false);
  useEffect(() => {
    if (picking || !refocusChange.current) return;
    refocusChange.current = false;
    changeButtonRef.current?.focus();
  }, [picking, selectedCompany]);

  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [showMoreCompanyFields, setShowMoreCompanyFields] = useState(false);
  const [companyForm, setCompanyForm] = useState<CompanyFieldValues>(emptyCompanyFields);
  const [companyIndustryId, setCompanyIndustryId] = useState<string | null>(null);
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

  function openPicker() {
    // The combobox mounts afresh, so it fetches afresh: what it showed the last
    // time the picker was open predates anything created or changed since.
    setFocusPicker(true);
    setPicking(true);
  }

  function runSetClient(nextCompanyId: string, nextContactId: string) {
    setError(null);
    startTransition(async () => {
      const result = await setDocumentClient(documentId, nextCompanyId, nextContactId || null);
      if (result?.error) setError(result.error);
    });
  }

  function handleSelectCompany(nextCompany: ClientSearchCompany) {
    // The company is kept whole as the selection, not looked up in the
    // combobox's results later: the next search replaces them.
    setSelectedCompany(nextCompany);
    // Mirror the server's auto-primary-contact resolution (setDocumentClient)
    // for an immediate UI reflection: `contacts` is already ordered isPrimary
    // desc, firstName asc (see searchClientCompanies), so [0] is exactly
    // the contact the server will assign when no contactId is submitted.
    setContactId(nextCompany.contacts[0]?.id ?? "");
    runSetClient(nextCompany.id, "");
    refocusChange.current = true;
    setPicking(false);
    setShowContactForm(false);
  }

  function handleContactChange(nextContactId: string) {
    setContactId(nextContactId);
    if (selectedCompany) runSetClient(selectedCompany.id, nextContactId);
  }

  function closeCompanyForm() {
    setShowCompanyForm(false);
    setCompanyFormError(null);
    setCompanyForm(emptyCompanyFields());
    setCompanyIndustryId(null);
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
    const result = await createCompanyInline({ ...companyForm, industryId: companyIndustryId });
    setCompanyFormPending(false);

    if ("error" in result) {
      setCompanyFormError(result.error);
      return;
    }

    // Selected straight from what the action returned. It never goes through
    // the search, so it does not matter that the current results do not
    // contain it (and the next time the picker opens it is fetched afresh).
    setSelectedCompany({
      id: result.company.id,
      name: result.company.name,
      industryId: companyIndustryId,
      city: companyForm.city.trim() || null,
      country: companyForm.country || null,
      contacts: [],
    });
    setContactId("");
    refocusChange.current = true;
    setPicking(false);
    closeCompanyForm();
    runSetClient(result.company.id, "");
    toast.success(`${result.company.name} created`);
  }

  async function handleCreateContact() {
    if (!selectedCompany) return;
    const companyId = selectedCompany.id;
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
    setSelectedCompany((current) =>
      current && current.id === companyId
        ? {
            ...current,
            contacts: [
              ...current.contacts,
              {
                id: result.contact.id,
                firstName: trimmedFirstName,
                lastName: trimmedLastName || null,
                isPrimary: current.contacts.length === 0,
              },
            ],
          }
        : current
    );
    setContactId(result.contact.id);
    closeContactForm();
    runSetClient(companyId, result.contact.id);
    toast.success(`${result.contact.label} created`);
  }

  return (
    <SectionCard
      title="Client"
      icon={<Building2 className="size-5" />}
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
        <ReadOnlyValue empty="No client set">{selectedCompany?.name}</ReadOnlyValue>
      ) : (
        <div className="flex flex-col gap-3">
          {selectedCompany && !picking ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Building2 className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-brand-dark">{selectedCompany.name}</p>
                  <p className="text-xs text-slate-500">
                    {[
                      clientLocation(selectedCompany),
                      selectedCompany.contacts.length === 0
                        ? "No contacts on file"
                        : `${selectedCompany.contacts.length} contact${selectedCompany.contacts.length === 1 ? "" : "s"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <button
                ref={changeButtonRef}
                type="button"
                onClick={openPicker}
                disabled={pending}
                aria-label={`Change company (currently ${selectedCompany.name})`}
                // The way back to the picker, so a thumb-sized target: the
                // negative margin keeps the card as tall as it was.
                className="focus-ring -m-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md p-2 text-xs font-medium text-brand hover:underline"
              >
                Change
              </button>
            </div>
          ) : (
            <ClientCombobox
              disabled={pending}
              autoFocus={focusPicker}
              onSelect={handleSelectCompany}
            />
          )}

          {showCompanyForm ? (
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CompanyField binding={companyBinding} field="name" required />
                <CompanyField binding={companyBinding} field="city" />
                <CompanyField binding={companyBinding} field="country" />
                <CompanyField binding={companyBinding} field="website" className="sm:col-span-2" />
                <FieldRow label="Industry" htmlFor="inline-company-industry" className="sm:col-span-2">
                  <IndustryPicker
                    id="inline-company-industry"
                    industries={industries}
                    selectedId={companyIndustryId}
                    onChange={setCompanyIndustryId}
                    allowCreate={false}
                    usageCount={null}
                    canRename={false}
                  />
                </FieldRow>
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
                  disabled={companyFormPending || !companyForm.name.trim()}
                  variant="brand"
                  className="h-11 sm:h-9"
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
                <label
                  htmlFor={`${documentId}-contact`}
                  className="text-sm font-medium text-brand-dark"
                >
                  Contact
                </label>
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
                  id={`${documentId}-contact`}
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
                <EmptyState
                  icon={UserPlus}
                  title="No contacts yet"
                  description="Add one so the quote can be addressed to a person."
                  bordered={false}
                  compact
                />
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
                      variant="brand"
                  className="h-11 sm:h-9"
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
