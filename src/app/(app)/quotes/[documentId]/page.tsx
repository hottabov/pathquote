import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  Download,
  Eye,
  Percent,
  Truck,
  CalendarClock,
  StickyNote,
  ScrollText,
  Camera,
  Receipt,
  PenLine,
} from "lucide-react";
import { auth } from "@/auth";
import { requireRegion } from "@/lib/authz";
import { isAdminRole } from "@/lib/roles";
import {
  getDocumentForBuilder,
  getDocumentForForms,
  getItemPickerCatalog,
  listCompatibleOptionsForProducts,
  type CompatKey,
  type DocumentForBuilder,
} from "@/lib/queries/documents";
import type { ClientSearchCompany } from "@/lib/queries/client-search";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { resolveQuoteDocuments } from "@/lib/quotation-data";
import { catalogVisibilityUserId } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { getQuoteValidityDays, getShowOptionIcons } from "@/lib/queries/settings";
import { getSpecImages } from "@/lib/queries/spec-images";
import { SCREEN_SIDE_FIELD } from "@/lib/production-forms/spec-images";
import { getUser } from "@/lib/queries/users";
import { canAuthorSign, canRevoke, canSendToClient, signingStatusLabel } from "@/lib/signing/state";
import { concessionCapMessage, markupCapMessage } from "@/lib/pricing";
import { formatDateAU } from "@/lib/format";
import { renderStoredRichText } from "@/lib/rich-text";
import { SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { ClientSection } from "@/components/builder/client-section";
import { HeroImageSection } from "@/components/builder/hero-image-section";
import { ItemsSection } from "@/components/builder/items-section";
import { ExtraLinesSection } from "@/components/builder/extra-lines-section";
import { DocumentDiscountField } from "@/components/builder/document-discount-field";
import { PriceDisplayToggles } from "@/components/builder/price-display-toggles";
import { NotesSection } from "@/components/builder/notes-section";
import { TermsDocumentsPanel } from "@/components/builder/terms-documents-panel";
import { ValidityDaysField } from "@/components/builder/validity-days-field";
import { DeliveryTaxField } from "@/components/builder/delivery-tax-field";
import { ProductionFormsSection } from "@/components/documents/production-forms-section";
import { DocumentTotals } from "@/components/builder/sticky-footer";
import { FinalizeButton } from "@/components/builder/finalize-button";
import { QuoteBar } from "@/components/builder/quote-bar";
import { BuilderPanels } from "@/components/builder/builder-panels";
import { builderTabsFor } from "@/lib/builder-tabs";
import { ReadinessPanel } from "@/components/builder/readiness-panel";
import { UnfinalizeButton } from "@/components/builder/unfinalize-button";
import { AcceptButton } from "@/components/builder/accept-button";
import { VoidSignatureButton } from "@/components/builder/void-signature-button";
import { UnsentChangesBanner } from "@/components/builder/unsent-changes-banner";
import { RevisionsSection, EmailHistorySection } from "@/components/builder/quote-history-sections";
import { getQuoteHistory } from "@/lib/queries/quote-revisions";
import { getQuoteActState } from "@/lib/queries/act-quote";
import { ActStateCard } from "@/components/documents/act-state-card";
import { showsQuoteActCard } from "@/lib/act/quote-act-view";
import { SignButton } from "@/components/builder/sign-button";
import { SendToClientButton } from "@/components/builder/send-to-client-button";
import { RevokeSigningLinkButton } from "@/components/builder/revoke-signing-link-button";
import { DeleteDraftButton } from "@/components/builder/delete-draft-button";
import { ConcessionCapToast } from "@/components/builder/concession-cap-toast";
import { quoteReadiness } from "@/lib/quote-readiness";
import { Tooltip } from "@/components/ui-kit/client";
import { HoverPrefetchLink } from "@/components/hover-prefetch-link";
import { pathWorksModulesWithoutHost } from "@/lib/production-forms/pathworks";
import { readProductSpecs } from "@/lib/validation/product-specs";
import { isQuoteDocumentIncluded } from "@/lib/quote-document-choice";

export const dynamic = "force-dynamic";

type Params = { documentId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { documentId } = await params;
  // Metadata runs before the page body — re-check scope here too so a
  // manager browsing to a foreign document never even sees its number in
  // the tab title.
  const session = (await auth())!;
  const document = await getDocumentForBuilder(session.user, documentId);
  if (!document) return { title: "Quote" };
  return { title: document.number ?? "New quote" };
}

export default async function DocumentBuilderPage({ params }: { params: Promise<Params> }) {
  const { documentId } = await params;
  // No `searchParams` here, on purpose. The open tab lives in the URL as
  // `?tab=` (so a link to a quote's setup or history can be sent, and a
  // reload lands where it was), but it is read on the CLIENT, by
  // `BuilderTabs` and `BuilderPanels`, and written with
  // `history.replaceState`. Reading it here made every tab switch a
  // navigation, and a navigation to this page is the whole builder query set
  // and 200+ KB of HTML -- for a panel whose content the browser already
  // had. This page renders every panel's content and lets the client decide
  // which to show; it must not grow a dependency on the query string again.
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  // `requireRegion` rather than a bare `auth()`: the builder prices items, and
  // a manager with no usable region has no price list to quote from, so this is
  // where they get redirected rather than shown an empty catalogue. Only the
  // session is needed below — the inline "+ New company" panel no longer asks
  // for a region, because a company doesn't have one.
  const { session } = await requireRegion();

  const document = await getDocumentForBuilder(session.user, documentId);
  // A foreign document (belongs to another manager) resolves to the same
  // `null` as a nonexistent one — never leak which case it was.
  if (!document) notFound();

  const isDraft = document.status === "DRAFT";
  // Which tabs this quote has (a draft has no Order forms). `BuilderPanels`
  // and `BuilderTabs` resolve `?tab=` against this same list, so a stale
  // `?tab=forms` on a draft lands on Build there, as it used to here.
  const builderTabs = builderTabsFor({ isFinal: !isDraft });
  const isAdmin = isAdminRole(session.user.role);

  // Only fetched for a FINAL document — a DRAFT never renders SignButton, so
  // there is no reason to pay for this read there. `getUser` (not the
  // session) because the session JWT only revalidates every few minutes (see
  // src/auth.ts) and this must reflect a signature drawn in Account just
  // before this page loaded.
  const mySignatureUrl = isDraft ? null : ((await getUser(session.user.id))?.signatureUrl ?? null);

  // Same message every mutating server action already builds (see
  // recalcDocument's own concessionMessage) — reused here for both the
  // persistent Summary-panel readiness row and the one-time transition toast
  // (see quoteReadiness/ConcessionCapToast) rather than a shorter paraphrase
  // that could drift from it. `null` whenever the document isn't over the
  // cap, which is also what makes both of those components render nothing.
  //
  // The markup ceiling (Region.maxMarkupPct) shares this exact row/toast
  // surfacing rather than a parallel mechanism of its own — see
  // recalcAndEnforce's own doc comment on why exceedsCap/exceedsMarkupCap
  // can never both be true for the same document at once, so at most one of
  // these two ternary branches ever actually applies.
  const capMessageText = document.documentConcession.exceedsCap
    ? concessionCapMessage(
        document.documentConcession,
        document.regionName,
        document.currency,
        document.currencySymbol
      )
    : document.documentConcession.exceedsMarkupCap
      ? markupCapMessage(
          document.documentConcession,
          document.regionName,
          document.currency,
          document.currencySymbol
        )
      : null;
  const capExceeded = document.documentConcession.exceedsCap || document.documentConcession.exceedsMarkupCap;

  // Compatible options are fetched for every distinct (productId, seriesId)
  // pair across the document's items (not once per item) -- in ONE read for
  // all of them (`listCompatibleOptionsForProducts`), where this used to
  // issue a product's whole 5-8-statement query per pair. Keyed by productId
  // when available (compatibility can differ product-to-product within the
  // same series, e.g. EasyLoader accessories only for EL-2020) and falling
  // back to `series:<seriesId>` for the defensive case of an item whose
  // product no longer resolves (see `BuilderItem.productId`'s doc comment).
  const compatKeysByKey = new Map<string, CompatKey>();
  for (const item of document.items) {
    if (!item.productId && !item.seriesId) continue;
    const key = item.productId ?? `series:${item.seriesId}`;
    if (!compatKeysByKey.has(key)) {
      compatKeysByKey.set(key, { key, productId: item.productId, seriesId: item.seriesId });
    }
  }
  const compatKeys = Array.from(compatKeysByKey.values());

  // Everything below depends on nothing but the session and the document
  // just loaded, so it all goes out together in one wave. It used to run in
  // three (hidden ids, then the batch, then the compatible-options fan-out)
  // and later grew a fourth -- the History tab's revision/email log and the
  // ACT! state card -- that waited for the batch though it needed only
  // `document.id`; both are in the batch now. Only the item picker actually
  // needs the hidden-id set in hand, so that one dependency is expressed as
  // a `then` on its own promise instead of an `await` that would hold back
  // the other reads with it.
  //
  // Whose visibility gates the item picker: the current *signed-in user*
  // (an ADMIN always resolves to `null` here and sees everything), not the
  // document's author or region — two managers in the same region can have
  // different catalogues, and it's whoever is looking at the picker right
  // now that matters.
  const hiddenCatalogIdsPromise = getHiddenCatalogIds(catalogVisibilityUserId(session.user));

  // Who is looking, for the ACT! card: where the quote's write into ACT!
  // stands is read under the same scope as the page (getQuoteActState), and
  // only for a viewer who gets the card at all -- canSeeActSync, through
  // showsQuoteActCard: a distributor has no ACT! access, and is not shown
  // the mechanism, though their quote is queued and sent all the same.
  const actViewer = { role: session.user.role, actSyncVisible: session.user.actSyncVisible };

  const [
    catalog,
    showOptionIcons,
    orgDefaultValidityDays,
    formsDocument,
    screenSideImages,
    quoteDocumentRows,
    compatibleOptionsByItemKey,
    history,
    actState,
  ] = await Promise.all([
    hiddenCatalogIdsPromise.then((hiddenCatalogIds) =>
      getItemPickerCatalog(document.regionCode, hiddenCatalogIds)
    ),
    getShowOptionIcons(),
    getQuoteValidityDays(),
    // Separate, narrower payload (see `productionFormsInclude`) than
    // `document` above. Only a FINAL quote has order forms (`builderTabsFor`
    // gives a draft no Forms tab), so a draft skips this read: it is a second
    // full load of the document (~11 statements) that `ProductionFormsSection`
    // would discard.
    isDraft ? null : getDocumentForForms(session.user, documentId),
    // The screen-side diagrams (owner: illustrate +Y/-Y rather than
    // leaving it as bare text) — fetched once per page load, same as
    // `showOptionIcons`, and threaded down through ItemsSection/ItemsList
    // to every item's ProductionSpecEditor.
    getSpecImages(SCREEN_SIDE_FIELD),
    // Every legal document visible to this quote's region — the same rows
    // the quotation renderer reads, reduced below by the same
    // `resolveQuoteDocuments`, so the tickboxes can never offer a document
    // the sheet would not print (or miss one it would).
    getQuoteDocumentsForRegion(document.regionId),
    listCompatibleOptionsForProducts(compatKeys, document.regionId),
    // Revision + send history: the History tab's content, and its count in
    // the tab strip. Scoped to the same user; null only for a foreign/missing
    // id, which cannot happen here since `document` already loaded under the
    // same scope.
    getQuoteHistory(session.user, document.id),
    showsQuoteActCard(actViewer) ? getQuoteActState(session.user, document.id) : null,
  ]);

  // The client picker is handed the quote's own company and nothing else; the
  // rest of the client list is searched for on demand (src/lib/actions/
  // client-search.ts). `document.company` is that company already, loaded by
  // `getDocumentForBuilder` with its contacts in the order the picker needs
  // (isPrimary desc, firstName asc), so this costs no query. Mapped down to
  // the picker's fields on purpose: `BuilderCompany` carries a whole address
  // and `BuilderContact` also carries email and phone, and anything passed as
  // a prop to a client component is serialised into the page.
  const pickerCompany: ClientSearchCompany | null = document.company
    ? {
        id: document.company.id,
        name: document.company.name,
        industryId: document.company.industryId,
        city: document.company.city,
        country: document.company.country,
        contacts: document.company.contacts.map((contact) => ({
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          isPrimary: contact.isPrimary,
        })),
      }
    : null;

  // One row per key for this region (its own version where it has one, the
  // global default otherwise), in the print order an admin set — the same
  // selection `buildQuotationData` makes, minus the inclusion filter, which
  // is exactly what the panel is for.
  const panelDocuments = Array.from(resolveQuoteDocuments(quoteDocumentRows, document.regionId).values())
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => ({ key: row.key, title: row.title, includedByDefault: row.includedByDefault }));

  // Sanitized here rather than inside `NotesSection`, which renders it through
  // `dangerouslySetInnerHTML`: `Document.notes` is a raw column that may
  // predate the write-boundary allowlist (`setDocumentNotes`), so the
  // read-side pass is not optional — but there is no reason for it to happen
  // in the browser, where it costs every visitor the DOMPurify bundle and
  // leaves the page's safety resting on code that shares a runtime with
  // whatever the markup itself might do. See `NotesSection`'s doc comment for
  // why only the read-only branch needs this and the editor branch does not.
  const notesHtml = document.notes ? renderStoredRichText(document.notes) : null;

  // One derivation of "is this quote ready", read by both the rail's panel
  // and the Finalize button, so the two can never disagree about it. The
  // page used to compute a version of this inline, further down, purely to
  // hand FinalizeButton a string.
  const readinessRows = quoteReadiness({
    hasCompany: document.company !== null,
    hasContact: document.contactId !== null,
    items: document.items.map((item) => ({
      id: item.id,
      code: item.code,
      form: item.form,
      productionSpec: item.productionSpec,
      options: item.lines
        .filter((line) => line.kind === "OPTION")
        .map((line) => ({ role: line.role, attributes: line.attributes })),
    })),
    extraLineCount: document.extraLines.length,
    printedDocumentCount: panelDocuments.filter(
      (row) => isQuoteDocumentIncluded(row, document.documentChoices)
    ).length,
    discountViolations: document.discountViolations,
    // `capMessageText` is one or the other (both can never be true at once
    // — see its own comment above); split back here so the row is labelled
    // for the limit it is actually about.
    discountCapMessage: document.documentConcession.exceedsCap ? capMessageText : null,
    markupCapMessage: document.documentConcession.exceedsMarkupCap ? capMessageText : null,
    // The same test the order forms apply, run here so the remark reaches
    // the manager while the quote is still a draft rather than after
    // finalisation, on a page they only open once the decision is made.
    pathWorksModulesWithoutHost: pathWorksModulesWithoutHost(
      document.items
        .filter((item) => item.kind === "SOFTWARE")
        .map((item) => ({ specs: readProductSpecs(item.specs) }))
    ),
    taxBlocker: document.taxBlocker,
  });

  // Only the two tabs where a count says something. Quote setup has a fixed
  // number of cards, so a badge there would be decoration.
  const historyCount = (history?.revisions.length ?? 0) + (history?.emails.length ?? 0);

  return (
    <div className="flex flex-col gap-6 pb-4">
      <QuoteBar
        number={document.number}
        status={document.status}
        total={document.total}
        currency={document.currency}
        currencySymbol={document.currencySymbol}
        tabs={builderTabs}
        tabCounts={{ build: document.items.length, history: historyCount }}
      >
        {isDraft ? (
          <FinalizeButton documentId={document.id} rows={readinessRows} />
        ) : null}
      </QuoteBar>

      {/* Never while the client has already signed — a signed quote has, by
          definition, no changes waiting to be sent (and clears any stale flag
          left by an older send that predated the flag being cleared on send). */}
      <UnsentChangesBanner
        hasUnsentChanges={document.hasUnsentChanges && document.signingStatus !== "SIGNED"}
        sentAt={document.sentAt}
        label={document.number}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Every panel's content is rendered here, server-side -- the data
              for all of them is already in hand from the single Promise.all
              above -- and handed to `BuilderPanels`, which mounts only the
              active one (and keeps a panel once it has been shown). So the
              HTML carries one panel, the hidden ones' client components do
              not hydrate, and the Quote-setup panel's rich-text editor is
              not downloaded until someone opens Quote setup. Switching tabs
              is a client render: `?tab=` changes by `history.replaceState`,
              and this page is not re-requested. */}
          <BuilderPanels
            tabs={builderTabs}
            panels={{
              build: (
                <>
          <ClientSection
            documentId={document.id}
            initialCompany={pickerCompany}
            initialContactId={document.contactId}
            readOnly={!isDraft}
          />

          <ItemsSection
            documentId={document.id}
            items={document.items}
            currency={document.currency}
            currencySymbol={document.currencySymbol}
            catalog={catalog}
            compatibleOptionsByItemKey={compatibleOptionsByItemKey}
            showOptionIcons={showOptionIcons}
            screenSideImages={screenSideImages}
            readOnly={!isDraft}
          />

          <ExtraLinesSection
            documentId={document.id}
            lines={document.extraLines}
            currency={document.currency}
            currencySymbol={document.currencySymbol}
            readOnly={!isDraft}
          />

          {/* Last on Build, under everything it comes off. A discount is
              money on this quote, and it sat on the setup tab between the
              delivery terms and the quote validity, where a salesperson
              assembling a quote had no reason to look. */}
          <SectionCard title="Discount" icon={<Percent className="size-5" />}>
            <DocumentDiscountField
              documentId={document.id}
              discountMode={document.discountMode}
              discountValue={document.discountValue}
              currency={document.currency}
              currencySymbol={document.currencySymbol}
              readOnly={!isDraft}
            />
          </SectionCard>
                </>
              ),

              /* Quote setup: everything that is set once per quote rather
                 than touched while assembling it. These cards used to sit in
                 the same single column as the machines, in the same visual
                 register, so "Setup image" and "Items" looked equally
                 important and a salesperson scrolled past five of them on
                 every quote.

                 Called "Quote setup" rather than "Settings", which is already
                 the name of a whole section of this app: one word with two
                 meanings in one product is how a person ends up in the wrong
                 place. */
              settings: (
                <>

          {/* First on the tab. It is the one thing here that is a piece of
              work rather than a setting -- a photo to find and drop in --
              and it prints on the quotation's first page, so it leads the
              tab that decides what the quotation says. */}
          <SectionCard
            title="Setup image"
            description="A photo of the finished configuration, shown full width on the quotation's first page."
            icon={<Camera className="size-5" />}
          >
            <HeroImageSection
              documentId={document.id}
              heroImageUrl={document.heroImageUrl}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* Two small document-level fields, side by side on md+ (they each
              hold a single control, so a full-width card apiece wasted the
              row); they stack on mobile. Discounts used to make three of
              them and has moved to Build: a discount is money on the quote,
              and it belongs beside the machines it comes off. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Incoterm + tax for this quote. The app suggests the tax from
                the seller's and the client's countries; the salesperson may
                replace it with a Custom tax and a reason (Vadym, 2026-09-30). */}
            <SectionCard title="Delivery & tax" icon={<Truck className="size-5" />}>
              <DeliveryTaxField
                documentId={document.id}
                incoterm={document.incoterm}
                taxTreatment={document.taxTreatment}
                taxName={document.taxName}
                taxRate={document.taxRate}
                taxOverridden={document.taxOverridden}
                taxNote={document.taxNote}
                suggestion={document.taxSuggestion}
                blocker={document.taxBlocker}
                sellerCountry={document.sellerCountry}
                destinationCountry={document.destinationCountry}
                readOnly={!isDraft}
              />
            </SectionCard>

            {/* Per-quote validity override (owner: "What's your capex process?
                ... I'll give you eight [weeks]"). Defaults to the org-wide
                setting (/settings) when the document has no override. */}
            <SectionCard title="Quote validity" icon={<CalendarClock className="size-5" />}>
              <ValidityDaysField
                documentId={document.id}
                validityDays={document.validityDays}
                orgDefaultDays={orgDefaultValidityDays}
                readOnly={!isDraft}
              />
            </SectionCard>
          </div>

          {/* Freeform remarks carried through to whichever renderer the
              document uses (see NotesSection's doc comment). */}
          <SectionCard title="Notes" icon={<StickyNote className="size-5" />}>
            <NotesSection
              documentId={document.id}
              notes={document.notes}
              notesHtml={notesHtml}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* What this quote promises, and which legal documents carry it.
              Delivery and warranty are negotiated per deal, so a quote may
              promise something other than its region's standard; RSP printed
              on every quote whether or not the customer bought it, and is a
              tickbox now. Sits between Notes and the setup image because it
              is the last thing about the *deal* before the panels that are
              purely about how the sheet looks. */}
          <SectionCard
            title="Terms and documents"
            description="The figures this quote promises, and the agreements it prints."
            icon={<ScrollText className="size-5" />}
          >
            <TermsDocumentsPanel
              documentId={document.id}
              region={document.region}
              terms={{
                deliveryWeeks: document.deliveryWeeks,
                installationDays: document.installationDays,
                trainingDays: document.trainingDays,
                warrantyMonths: document.warrantyMonths,
              }}
              documents={panelDocuments}
              choices={document.documentChoices}
              readOnly={!isDraft}
            />
          </SectionCard>

          <SectionCard title="Quotation pricing display" icon={<Eye className="size-5" />}>
            <PriceDisplayToggles
              documentId={document.id}
              showItemPrices={document.showItemPrices}
              showOptionPrices={document.showOptionPrices}
              readOnly={!isDraft}
            />
          </SectionCard>
                </>
              ),

              /* History: read-only, and nothing anyone edits. It had no
                 business sharing a column with the machines. Revisions, then
                 the email log. The order forms used to sit between them,
                 which is how a manager came to find the one thing the
                 workshop needs filed under "History" -- a word that promises
                 a record of what happened, not a job to do. */
              history: (
                <>
                  {history ? (
                    <RevisionsSection
                      revisions={history.revisions}
                      documentId={document.id}
                      currency={document.currency}
                      currencySymbol={document.currencySymbol}
                    />
                  ) : null}
                  {history ? <EmailHistorySection emails={history.emails} /> : null}
                </>
              ),

              /* Order forms: what the workshop builds from, and only a FINAL
                 quote has any. The tab itself only exists then -- see
                 `builderTabsFor`, and `formsDocument` is only read then --
                 so `BuilderPanels` never has a Forms panel to show for a
                 draft, whatever the URL says. */
              forms: formsDocument ? <ProductionFormsSection document={formsDocument} /> : undefined,
            }}
          />
        </div>

        {/* Right column: readiness, then the money, then signing. Every card
            renders at every breakpoint and exactly once; the old arrangement
            had Summary as desktop-only with a second status/actions block
            below the grid for smaller screens, which is how a tablet ended up
            with neither the totals nor the rail. Sticky on lg. */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-24 lg:col-span-1">
          <div>
            <SectionCard title="Summary" icon={<Receipt className="size-5" />}>
              <div className="flex flex-col gap-4">
                {/* No status badge or quote number here any more: the quote
                    bar at the top of the screen carries both, at every
                    width, and this card repeating them was half of the
                    duplication this layout set out to remove. */}
                {/* Everything this quote has to say about itself, in one
                    place: every refusal Finalize can return, the region
                    caps and per-item discount limits included, plus the
                    advisory remarks. See `quoteReadiness`. */}
                <ReadinessPanel rows={readinessRows} />
                <div className="border-t border-divider pt-4">
                  <DocumentTotals
                    taxName={document.taxName}
                    taxRate={document.taxRate}
                    subtotal={document.summarySubtotal}
                    discountAmount={document.summaryDiscountAmount}
                    taxAmount={document.taxAmount}
                    total={document.total}
                    currency={document.currency}
                    currencySymbol={document.currencySymbol}
                    commission={document.commission}
                    taxOverridden={document.taxOverridden}
                    taxNote={document.taxNote}
                  />
                </div>
                <div className="flex flex-col gap-2 border-t border-divider pt-4">
                  <DocumentActions
                    document={document}
                    isDraft={isDraft}
                    isAdmin={isAdmin}
                    mySignatureUrl={mySignatureUrl}
                  />
                </div>
              </div>
            </SectionCard>
          </div>

          <SigningPanel document={document} />

          {/* Where the quote's write into ACT! stands, next to the signing
              that is one of the things that sends it, and -- for an admin --
              what can be done about it. For viewers with ACT! sync only
              (actState is null for anyone else); renders nothing for a draft
              whose write is not still in the queue, or, for anyone but an
              admin, a quote that is not queued. */}
          {actState ? (
            <ActStateCard state={actState} viewer={actViewer} documentId={document.id} now={new Date()} />
          ) : null}
        </aside>
      </div>


      {/* Mounted once, renders nothing visible — see its own doc comment.
          Every role: an over-cap save is kept as a draft with a warning, and
          Finalize is what refuses it. */}
      <ConcessionCapToast exceedsCap={capExceeded} message={capMessageText} />

      {/* The mobile sticky totals bar is gone: the quote bar at the top of
          the screen carries the total at every width now, so the figure is
          never shown twice on one screen and never missing on a tablet. */}
    </div>
  );
}

/**
 * The audit trail `SigningRequest`/`Document.completedAt` already record but
 * that, until this panel, no screen in the app ever showed a manager — see
 * this task's own framing ("the manager cannot see where a quote sits").
 *
 * Renders nothing at all when `signingRequests` is empty: an unsent quote is
 * the ordinary case (most quotes, always, while DRAFT and often for a while
 * after FINAL), and a panel that says "not sent" on every single one of them
 * would be pure noise. Once a quote has been sent even once, though, the
 * panel stays -- including after a revoke resets `signingStatus` back to
 * NOT_SENT, because "this was sent and pulled back" is exactly the kind of
 * history a manager opening the quote later would want, unlike "never sent",
 * which needs no telling.
 *
 * Shows only the most recent `SigningRequest` (`signingRequests[0]`, already
 * sorted newest-first by the query -- see that field's own doc comment on
 * `DocumentForBuilder`) rather than the full history: a resend is common
 * (a typo in the address, a revision after a decline) and a wall of revoked
 * rows repeating the same quote number would bury the one row that matters
 * behind noise nobody asked for. The one piece of history that *is* worth
 * keeping -- how many times this has gone out -- survives as the request
 * count in the card's description instead of a full row each.
 */
function SigningPanel({ document }: { document: DocumentForBuilder }) {
  const current = document.signingRequests[0];
  if (!current) return null;

  const label = signingStatusLabel(document.signingStatus);
  const sentCount = document.signingRequests.length;

  return (
    <SectionCard
      title="Signing"
      description={sentCount > 1 ? `Sent to the client ${sentCount} times.` : undefined}
      icon={<PenLine className="size-5" />}
    >
      <div className="flex flex-col gap-3 text-sm text-brand-dark">
        {label ? (
          <div>
            <StatusBadge tone={STATUS_TONE[document.signingStatus]}>{label}</StatusBadge>
          </div>
        ) : null}

        <dl className="flex flex-col gap-1.5">
          <div>
            <dt className="inline font-medium text-slate-500">Sent to </dt>
            <dd className="inline">
              {current.email} on {formatDateAU(current.sentAt)}
            </dd>
          </div>
          {current.firstViewedAt ? (
            <div>
              <dt className="inline font-medium text-slate-500">First viewed </dt>
              <dd className="inline">{formatDateAU(current.firstViewedAt)}</dd>
            </div>
          ) : null}
          {document.signingStatus === "SIGNED" && document.completedAt ? (
            <div>
              <dt className="inline font-medium text-slate-500">Signed </dt>
              <dd className="inline">{formatDateAU(document.completedAt)}</dd>
            </div>
          ) : null}
          {current.declinedAt ? (
            <div>
              <dt className="inline font-medium text-slate-500">Declined </dt>
              <dd className="inline">{formatDateAU(current.declinedAt)}</dd>
            </div>
          ) : null}
          {/* Only reachable when `label` above is null (NOT_SENT) -- a live
              request is never revoked (see `revokeSigningLink`'s own doc
              comment), so `current.revokedAt` and a rendered signing badge
              never coexist. */}
          {!label && current.revokedAt ? (
            <div>
              <dt className="inline font-medium text-slate-500">Link revoked </dt>
              <dd className="inline">{formatDateAU(current.revokedAt)}</dd>
            </div>
          ) : null}
        </dl>

        {/* The single most useful fact on this panel (see the task's own
            framing) -- given its own callout rather than folded into the
            `<dl>` above so it cannot be scanned past. */}
        {current.declineReason ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
            <p className="text-xs font-semibold tracking-wide text-rose-700 uppercase">Decline reason</p>
            <p className="mt-1 text-rose-900">{current.declineReason}</p>
          </div>
        ) : null}

        {/* No "View signed PDF" link here on purpose: the Summary panel's
            "Quotation PDF" already downloads the signed quote once it's
            signed, and we don't split one action across two controls. */}
      </div>
    </SectionCard>
  );
}

/** The Preview / Download / Delete row: three of these side by side, each
 * taking a third of the card. Icon only -- the words were saying what card
 * they are already in -- with the label in a tooltip and an aria-label, so
 * nothing is lost to a screen reader or to a pointer that pauses. */
const actionIconClass =
  "focus-ring flex h-11 w-full items-center justify-center rounded-lg border border-slate-200 bg-white text-brand-dark transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none md:hover:bg-slate-50";

function DocumentActions({
  document,
  isDraft,
  isAdmin,
  mySignatureUrl,
}: {
  document: DocumentForBuilder;
  isDraft: boolean;
  isAdmin: boolean;
  /** The signed-in viewer's own saved signature (`User.signatureUrl`), or
   * `null` on a DRAFT where it was never fetched — see the page body's own
   * comment. Feeds SignButton's "Use this" shortcut. */
  mySignatureUrl: string | null;
}) {
  // The quotation (content-block-driven, Phase 6) is the only customer-
  // facing rendering of a document now — the older plain line-item
  // "Summary" sheet/PDF was removed (owner: "нам не потрібно мати Summary.
  // Тільки повний quotation.").
  //
  // Computed unconditionally (cheap, pure) even though it's only rendered
  // for a FINAL document below — `canSendToClient` itself is what turns a
  // DRAFT into a "Finalize the quote before signing it" reason, so there's
  // no separate `isDraft` branch to maintain here.
  const contactEmail = document.contact?.email ?? null;
  const sendVerdict = canSendToClient({
    documentStatus: document.status,
    signingStatus: document.signingStatus,
    contactEmail,
  });
  return (
    <div className="flex flex-col gap-2">
      {/* Finalize is NOT here. It is the one action that moves a draft
          forward, so it lives in the quote bar at the top of the screen
          where it is reachable without scrolling past three machines; this
          stack is the secondary actions. */}
      {isDraft ? null : (
        <>
          {/* Signing is offered to whoever this page already scoped the
              document to (its author, or any admin — see
              `signQuoteAsAuthor`'s own `documentWhereForUser` check). The
              manager may sign a FINAL quote in ANY order relative to the
              client — before sending, while the link is out, or after the
              client has signed (the counter-signature that then enables
              Accept). `canAuthorSign` is unconditional now; the gate stays so
              the button and the action share one rule. */}
          {canAuthorSign() ? (
            <SignButton
              documentId={document.id}
              hasAuthorSignature={document.signatures.some((s) => s.role === "AUTHOR")}
              savedSignatureUrl={mySignatureUrl}
            />
          ) : null}
          {/* Unlike SignButton above, this is always rendered for a FINAL
              document rather than hidden when the verdict fails — a manager
              should be able to see *why* sending isn't available (e.g. "Sign
              the quote before sending it.") via its tooltip, not just that
              it's missing. */}
          <SendToClientButton
            documentId={document.id}
            contactEmail={contactEmail}
            disabledReason={sendVerdict.ok ? null : sendVerdict.reason}
          />
          {/* Only while a link is actually live -- canRevoke is DocuSign's
              Void restriction (src/lib/signing/state.ts): nothing revokes a
              document that hasn't been sent, has already been signed, or
              was declined. */}
          {canRevoke(document.signingStatus) ? (
            <RevokeSigningLinkButton documentId={document.id} />
          ) : null}
        </>
      )}
      {/* Unfinalize is now for the owner (this page is already scoped to the
          author or an admin) as well as an admin (spec §4), but only before
          the client signs — once SIGNED the only way back is an admin's Void
          signature below. Accept moves a fully-signed quote into production
          (spec §1); it needs the manager's own signature present too. */}
      {!isDraft && document.signingStatus !== "SIGNED" ? (
        <UnfinalizeButton
          documentId={document.id}
          wasSent={document.signingStatus === "SENT" || document.signingStatus === "VIEWED"}
          sentLabel={document.number}
        />
      ) : null}
      {!isDraft &&
      document.signingStatus === "SIGNED" &&
      document.signatures.some((s) => s.role === "AUTHOR") &&
      !document.acceptedAt ? (
        <AcceptButton documentId={document.id} />
      ) : null}
      {!isDraft && document.signingStatus === "SIGNED" && isAdmin ? (
        <VoidSignatureButton documentId={document.id} />
      ) : null}

      {/* Three on one row rather than three stacked full-width buttons.
          Every word in "Quotation preview" and "Quotation PDF" beyond the
          verb was saying what card they are already in, and the stack cost
          three rows of a column that is the tallest thing on the page. */}
      <div className="grid grid-cols-3 gap-2">
        <Tooltip label="Preview the quotation">
          <HoverPrefetchLink
            href={`/quotes/${document.id}/quotation`}
            aria-label="Preview the quotation"
            className={actionIconClass}
          >
            <Eye className="size-4" aria-hidden="true" />
          </HoverPrefetchLink>
        </Tooltip>

        <Tooltip label="Download the quotation PDF">
          <a
            href={`/api/quotes/${document.id}/quotation-pdf`}
            aria-label="Download the quotation PDF"
            className={actionIconClass}
          >
            <Download className="size-4" aria-hidden="true" />
          </a>
        </Tooltip>

        {/* Only a draft can be deleted. A FINAL quote leaves the row a
            column short rather than shifting the other two: the two that
            are always there keep the same place and the same width
            whichever state the quote is in. */}
        {isDraft ? <DeleteDraftButton documentId={document.id} /> : <span aria-hidden="true" />}
      </div>
    </div>
  );
}
