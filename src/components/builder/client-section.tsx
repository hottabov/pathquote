"use client";

import { useEffect, useState, useTransition } from "react";
import { Building2, Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, FieldRow, ReadOnlyValue, SectionCard, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
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
import { cn } from "@/lib/utils";
import { setDocumentClient } from "@/lib/actions/documents";
import { createCompanyInline, createContactInline } from "@/lib/actions/clients";
import { searchClients } from "@/lib/actions/client-search";
import {
  CLIENT_SEARCH_MIN_LENGTH,
  CLIENT_SEARCH_PAGE_SIZE,
  clientResultLabel,
  clientSearchTerm,
} from "@/lib/client-search";
import type { ClientSearchCompany } from "@/lib/queries/client-search";

/** How long typing must pause before the search goes to the server. Short
 * enough to feel live, long enough that "noitex" is one request and not six --
 * which matters more than usual here, because Next.js runs Server Actions one
 * at a time per client, so every request sent also queues whatever the manager
 * does next (picking a company is another Server Action) behind it. */
const SEARCH_DEBOUNCE_MS = 200;

/** One finished search. `term` is the normalised term it answered
 * (`clientSearchTerm`), kept with the results so the list is labelled and the
 * "nothing matches" message worded for the search that produced them, not for
 * whatever has been typed since. */
type SearchOutcome = { term: string; companies: ClientSearchCompany[]; failed: boolean };

/**
 * The builder's "Client" section: a search box, then a company select fed by
 * that search, and — once a company with contacts is chosen — a contact
 * select. Every change calls `setDocumentClient` directly (no <form>, same
 * pattern as the "make primary" star in
 * src/components/clients/contacts-section.tsx) so picking a client is a
 * single tap with no separate "save" step. Once a company is selected it
 * collapses to a small summary card with a "Change" action, so the picker
 * itself only reappears when actually switching clients.
 *
 * THE SEARCH IS SERVER-SIDE, AND THAT IS NOT AN OPTIMISATION TO UNDO. This
 * section used to be handed every company the viewer could see, each with all
 * its contacts, and filtered them in the browser ("companies are a small
 * list"). That held while the table had two rows. After the ACT! CRM import
 * it was 8,810 companies and 10,473 contacts: 2,158 kB of JSON serialised,
 * shipped and hydrated on every builder page open, against 29 ms of SQL
 * (measured on the rehearsal database, 2026-10-08). Vadym's call, for the
 * reason that a sluggish builder makes the product look amateur to the people
 * who use it all day. The page now passes only the quote's own company
 * (`initialCompany`); the picker asks `searchClients`
 * (src/lib/actions/client-search.ts) for the 20 best matches by company or
 * contact name, debounced, and shows them in the select. Do not put the full
 * list back, however convenient the instant filter was.
 *
 * Two consequences the code below is built around:
 *   - The selected company is held as an object of its own, not looked up in
 *     the current results. Results are replaced on every search, so a lookup
 *     would lose the selection the moment the manager typed after picking.
 *   - Responses can arrive out of order. A slow answer for "no" must never
 *     replace the answer for "noitex" typed after it. Each search effect
 *     carries a `current` flag that its cleanup clears; a change of search
 *     term (or closing the picker) runs the cleanup first, so a response only
 *     lands if nothing newer has superseded its request. Not an
 *     AbortController: a Server Action takes no signal, so the request would
 *     run to completion either way and only the answer can be ignored.
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
  const [query, setQuery] = useState("");
  const [contactId, setContactId] = useState(initialContactId ?? "");
  const [picking, setPicking] = useState(!initialCompany);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The latest finished search; null from the moment the picker opens until
  // its first answer. One slot, not a cache: a company or contact created
  // since an older answer would be missing from it.
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const term = clientSearchTerm(query);
  // Derived rather than stored, so there is no flag to forget to clear: the
  // picker is searching exactly when it is open and what it shows answers a
  // different term from the one typed.
  const searching = picking && !readOnly && outcome?.term !== term;
  // Something typed, but under the minimum: the list is the first page, and
  // the manager should be told why nothing narrowed.
  const tooShort = query.trim() !== "" && term === "";
  const statusId = `${documentId}-client-search-status`;

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

  // Runs a search whenever the term the picker should be showing differs from
  // the one it is showing (`searching`). `current` is the out-of-order guard
  // described in the header comment: cleanup clears it, so any response whose
  // request has been superseded (by a different term, the picker closing, or
  // unmount) is dropped. A failed search is recorded under its term too, so it
  // is not retried in a loop; "Try again" clears the outcome to ask again.
  useEffect(() => {
    if (!searching) return;
    let current = true;
    const timer = setTimeout(
      () => {
        searchClients(term).then(
          (result) => {
            if (!current) return;
            setOutcome(
              "error" in result
                ? { term, companies: [], failed: true }
                : { term, companies: result.companies, failed: false }
            );
          },
          () => {
            if (current) setOutcome({ term, companies: [], failed: true });
          }
        );
      },
      // The first page needs no waiting for: opening the picker, or clearing the box.
      term === "" ? 0 : SEARCH_DEBOUNCE_MS
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searching, term]);

  const results = outcome?.companies ?? [];

  function openPicker() {
    // Fetch afresh: the answer on screen from the last time the picker was
    // open predates anything created or changed since.
    setOutcome(null);
    setPicking(true);
  }

  function runSetClient(nextCompanyId: string, nextContactId: string) {
    setError(null);
    startTransition(async () => {
      const result = await setDocumentClient(documentId, nextCompanyId, nextContactId || null);
      if (result?.error) setError(result.error);
    });
  }

  function handleCompanyChange(nextCompanyId: string) {
    // The placeholder option, or an id that is no longer in the list: nothing
    // to select. (The document keeps whatever client it has; there is no
    // "no client" to switch to.)
    const nextCompany = results.find((c) => c.id === nextCompanyId);
    if (!nextCompany) return;

    // The company is kept whole as the selection, not looked up in `results`
    // later: the next search replaces `results`.
    setSelectedCompany(nextCompany);
    // Mirror the server's auto-primary-contact resolution (setDocumentClient)
    // for an immediate UI reflection: `contacts` is already ordered isPrimary
    // desc, firstName asc (see searchClientCompanies), so [0] is exactly
    // the contact the server will assign when no contactId is submitted.
    setContactId(nextCompany.contacts[0]?.id ?? "");
    runSetClient(nextCompany.id, "");
    setPicking(false);
    setQuery("");
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
      contacts: [],
    });
    setContactId("");
    setPicking(false);
    setQuery("");
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
                onClick={openPicker}
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
                  placeholder="Search companies or contacts…"
                  aria-label="Search companies or contacts"
                  aria-describedby={statusId}
                  className={cn(fieldInputClass, "pl-9")}
                  disabled={pending}
                />
              </div>

              <select
                aria-label="Company"
                aria-busy={searching}
                // Controlled only while the selection is among the options;
                // after "Change" the current client is usually not in the
                // list, and the placeholder is the honest thing to show.
                value={results.some((c) => c.id === selectedCompany?.id) ? selectedCompany?.id : ""}
                onChange={(e) => handleCompanyChange(e.target.value)}
                className={fieldInputClass}
                disabled={pending}
              >
                <option value="">{outcome === null ? "Loading companies…" : "Select a company…"}</option>
                {results.map((c) => (
                  <option key={c.id} value={c.id}>
                    {clientResultLabel(c, outcome?.term ?? "")}
                  </option>
                ))}
              </select>

              {/* Always rendered, so the screen-reader announcement has a
                  live region to land in, and a minimum height so the list
                  below does not jump as the message comes and goes. What it
                  says is the search's own state, in order of importance: a
                  failure, a search in flight, nothing found (with what to do
                  about it), a truncated page. */}
              <p id={statusId} role="status" aria-live="polite" className="min-h-4 text-xs text-slate-500">
                {searching ? (
                  "Searching…"
                ) : outcome?.failed ? (
                  <>
                    Search failed.{" "}
                    <button
                      type="button"
                      onClick={() => setOutcome(null)}
                      className="focus-ring rounded-md font-medium text-brand hover:underline"
                    >
                      Try again
                    </button>
                  </>
                ) : outcome && results.length === 0 ? (
                  outcome.term === ""
                    ? "No clients are available to you yet. Use + New company to add one."
                    : `No company or contact matches “${outcome.term}”. Check the spelling, try fewer letters, or use + New company.`
                ) : outcome && results.length >= CLIENT_SEARCH_PAGE_SIZE ? (
                  outcome.term === ""
                    ? `Showing the first ${CLIENT_SEARCH_PAGE_SIZE} companies. Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
                    : `Showing the first ${CLIENT_SEARCH_PAGE_SIZE} matches. Type more to narrow them down.`
                ) : tooShort ? (
                  `Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
                ) : null}
              </p>
            </div>
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
