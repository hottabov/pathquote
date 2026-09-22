import { notFound } from "next/navigation";
import Link from "next/link";
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
  listClientPickerCompanies,
  listCompatibleOptions,
  type CompatibleOption,
  type DocumentForBuilder,
} from "@/lib/queries/documents";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { resolveQuoteDocuments } from "@/lib/quotation-data";
import { catalogVisibilityUserId } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { getQuoteValidityDays, getShowOptionIcons } from "@/lib/queries/settings";
import { getSpecImages } from "@/lib/queries/spec-images";
import { SCREEN_SIDE_FIELD } from "@/lib/production-forms/spec-images";
import { getUser } from "@/lib/queries/users";
import { listIndustries } from "@/lib/queries/industries";
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
import { DeliveryTermsField } from "@/components/builder/delivery-terms-field";
import { ProductionFormsSection } from "@/components/documents/production-forms-section";
import { DocumentTotals } from "@/components/builder/sticky-footer";
import { FinalizeButton } from "@/components/builder/finalize-button";
import { QuoteBar } from "@/components/builder/quote-bar";
import { builderTabsFor, parseTab } from "@/lib/builder-tabs";
import { ReadinessPanel } from "@/components/builder/readiness-panel";
import { UnfinalizeButton } from "@/components/builder/unfinalize-button";
import { AcceptButton } from "@/components/builder/accept-button";
import { VoidSignatureButton } from "@/components/builder/void-signature-button";
import { UnsentChangesBanner } from "@/components/builder/unsent-changes-banner";
import { RevisionsSection, EmailHistorySection } from "@/components/builder/quote-history-sections";
import { getQuoteHistory } from "@/lib/queries/quote-revisions";
import { SignButton } from "@/components/builder/sign-button";
import { SendToClientButton } from "@/components/builder/send-to-client-button";
import { RevokeSigningLinkButton } from "@/components/builder/revoke-signing-link-button";
import { DeleteDraftButton } from "@/components/builder/delete-draft-button";
import { ConcessionCapBadge } from "@/components/builder/concession-cap-badge";
import { ConcessionCapToast } from "@/components/builder/concession-cap-toast";
import { quoteReadiness } from "@/lib/quote-readiness";
import { Tooltip } from "@/components/ui-kit/client";
import { pathWorksModulesWithoutHost } from "@/lib/production-forms/pathworks";
import { readProductSpecs } from "@/lib/validation/product-specs";

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

export default async function DocumentBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { documentId } = await params;
  // Which panel is showing. In the URL so the browser's back button steps
  // between them instead of leaving the quote, and so a link to a quote's
  // terms can be sent to someone. Resolved below, once the status is known:
  // which tabs a quote has depends on it, and `?tab=forms` on a draft is a
  // URL that has to land on Build rather than on a panel that renders
  // nothing.
  const tabParam = (await searchParams).tab;
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
  const builderTabs = builderTabsFor({ isFinal: !isDraft });
  const tab = parseTab(tabParam, builderTabs);
  const isAdmin = isAdminRole(session.user.role);

  // Only fetched for a FINAL document — a DRAFT never renders SignButton, so
  // there is no reason to pay for this read there. `getUser` (not the
  // session) because the session JWT only revalidates every few minutes (see
  // src/auth.ts) and this must reflect a signature drawn in Account just
  // before this page loaded.
  const mySignatureUrl = isDraft ? null : ((await getUser(session.user.id))?.signatureUrl ?? null);

  // Same message every mutating server action already builds (see
  // recalcDocument's own concessionMessage) — reused here for both the
  // persistent Summary-panel badge and the one-time transition toast (see
  // ConcessionCapBadge/ConcessionCapToast) rather than a shorter paraphrase
  // that could drift from it. `null` whenever the document isn't over the
  // cap, which is also what makes both of those components render nothing.
  //
  // The markup ceiling (Region.maxMarkupPct) shares this exact badge/toast
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

  // Compatible options are preloaded once per distinct (productId, seriesId)
  // pair across the document's items (not once per item) — most documents
  // have items from a handful of products at most, so this is a small,
  // cheap fan-out. Keyed by productId when available (compatibility can
  // differ product-to-product within the same series, e.g. EasyLoader
  // accessories only for EL-2020) and falling back to `series:<seriesId>`
  // for the defensive case of an item whose product no longer resolves
  // (see `BuilderItem.productId`'s doc comment).
  const compatKeys = new Map<string, { productId: string | null; seriesId: string | null }>();
  for (const item of document.items) {
    if (!item.productId && !item.seriesId) continue;
    const key = item.productId ?? `series:${item.seriesId}`;
    if (!compatKeys.has(key)) compatKeys.set(key, { productId: item.productId, seriesId: item.seriesId });
  }

  // Everything below depends on nothing but the session and the document
  // just loaded, so it all goes out together rather than in the three
  // sequential waves this used to run (hidden ids, then the batch, then the
  // compatible-options fan-out). Only the item picker actually needs the
  // hidden-id set in hand, so that one dependency is expressed as a `then`
  // on its own promise instead of an `await` that would hold back the other
  // six reads with it.
  //
  // Whose visibility gates the item picker: the current *signed-in user*
  // (an ADMIN always resolves to `null` here and sees everything), not the
  // document's author or region — two managers in the same region can have
  // different catalogues, and it's whoever is looking at the picker right
  // now that matters.
  const hiddenCatalogIdsPromise = getHiddenCatalogIds(catalogVisibilityUserId(session.user));

  // Started alongside the batch below rather than added to it, to keep that
  // destructuring untouched. Aliases ride along as search keys only.
  const industriesPromise = listIndustries();

  const [
    companies,
    catalog,
    showOptionIcons,
    orgDefaultValidityDays,
    formsDocument,
    screenSideImages,
    quoteDocumentRows,
    compatibleOptionsEntries,
  ] = await Promise.all([
    listClientPickerCompanies(session.user),
    hiddenCatalogIdsPromise.then((hiddenCatalogIds) =>
      getItemPickerCatalog(document.regionCode, hiddenCatalogIds)
    ),
    getShowOptionIcons(),
    getQuoteValidityDays(),
    // Separate, narrower payload (see `productionFormsInclude`) than
    // `document` above -- `ProductionFormsSection` returns `null` itself
    // for anything that isn't FINAL, so no status check is needed here.
    getDocumentForForms(session.user, documentId),
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
    Promise.all(
      Array.from(compatKeys.entries()).map(
        async ([key, { productId, seriesId }]) =>
          [key, await listCompatibleOptions(productId, seriesId, document.regionId)] as const
      )
    ),
  ]);

  const industries = (await industriesPromise).map((i) => ({
    id: i.id,
    name: i.name,
    aliases: i.aliases.map((alias) => ({ name: alias.name })),
  }));

  const compatibleOptionsByItemKey: Record<string, CompatibleOption[]> = Object.fromEntries(
    compatibleOptionsEntries
  );

  // One row per key for this region (its own version where it has one, the
  // global default otherwise), in the print order an admin set — the same
  // selection `buildQuotationData` makes, minus the exclusion filter, which
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
    deliveryTerms: document.deliveryTerms,
    printedDocumentCount: panelDocuments.filter(
      (row) => row.includedByDefault && !document.excludedDocumentKeys.includes(row.key)
    ).length,
    capExceeded,
    exceedsMarkupCap: document.documentConcession.exceedsMarkupCap,
    // The same test the order forms apply, run here so the remark reaches
    // the manager while the quote is still a draft rather than after
    // finalisation, on a page they only open once the decision is made.
    pathWorksModulesWithoutHost: pathWorksModulesWithoutHost(
      document.items
        .filter((item) => item.kind === "SOFTWARE")
        .map((item) => ({ specs: readProductSpecs(item.specs) }))
    ),
  });

  // Revision + send history: the History tab's content, and its count in
  // the tab strip. Scoped to the same user; null only for a foreign/missing
  // id, which cannot happen here since `document` already loaded under the
  // same scope.
  const history = await getQuoteHistory(session.user, document.id);


  const contactFullName = document.contact
    ? [document.contact.firstName, document.contact.lastName].filter(Boolean).join(" ")
    : null;
  // Only the two tabs where a count says something. "Quote terms" has a
  // fixed number of cards, so a badge there would be decoration.
  const historyCount = (history?.revisions.length ?? 0) + (history?.emails.length ?? 0);

  const title = document.company?.name ?? "New quote";

  return (
    <div className="flex flex-col gap-6 pb-4">
      <QuoteBar
        companyName={title}
        number={document.number}
        contactName={contactFullName}
        regionName={document.regionName}
        status={document.status}
        total={document.total}
        currency={document.currency}
        currencySymbol={document.currencySymbol}
        tabs={builderTabs}
        tabCounts={{ build: document.items.length, history: historyCount }}
      >
        {isDraft ? (
          <FinalizeButton
            documentId={document.id}
            // Over the region's discount cap or markup ceiling: a hard stop
            // at finalize for every role (validateFinalizable), shown up
            // front rather than on refusal.
            capBlocker={
              capExceeded
                ? document.documentConcession.exceedsMarkupCap
                  ? "the price is above the region\u2019s markup ceiling."
                  : "the discount is above the region\u2019s limit."
                : null
            }
            rows={readinessRows}
          />
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
          {/* All three panels are rendered server-side and two are hidden,
              rather than one being conditionally rendered: the data for all
              of them is already in hand from the single Promise.all above,
              so hiding costs nothing and switching tabs stays instant. */}
          <div
            role="tabpanel"
            id="builder-panel-build"
            aria-labelledby="builder-tab-build"
            hidden={tab !== "build"}
            className="flex flex-col gap-4"
          >
          <ClientSection
            documentId={document.id}
            companies={companies}
            industries={industries}
            initialCompanyId={document.company?.id ?? null}
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

          </div>

          {/* Quote terms: everything that is set once per quote rather than
              touched while assembling it. These seven cards used to sit in
              the same single column as the machines, in the same visual
              register, so "Setup image" and "Items" looked equally
              important and a salesperson scrolled past five of them on
              every quote. */}
          <div
            role="tabpanel"
            id="builder-panel-terms"
            aria-labelledby="builder-tab-terms"
            hidden={tab !== "terms"}
            className="flex flex-col gap-4"
          >

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

          {/* Three small document-level fields, side by side on md+ (they each
              hold a single control, so a full-width card apiece wasted the
              row); they stack on mobile. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <SectionCard title="Discounts" icon={<Percent className="size-5" />}>
              <DocumentDiscountField
                documentId={document.id}
                discountMode={document.discountMode}
                discountValue={document.discountValue}
                currency={document.currency}
                currencySymbol={document.currencySymbol}
                readOnly={!isDraft}
              />
            </SectionCard>

            {/* An export sale collected at the factory door is not a domestic
                taxable supply (the meeting question left unanswered: "What if
                there's no GST? If it's Ex Works?") — this is what lets a quote
                show no tax without hand-editing the tax rate. */}
            <SectionCard title="Delivery terms" icon={<Truck className="size-5" />}>
              <DeliveryTermsField
                documentId={document.id}
                deliveryTerms={document.deliveryTerms}
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
              excludedKeys={document.excludedDocumentKeys}
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

          </div>

          {/* History: read-only, and nothing anyone edits. It had no business
              sharing a column with the machines. */}
          <div
            role="tabpanel"
            id="builder-panel-history"
            aria-labelledby="builder-tab-history"
            hidden={tab !== "history"}
            className="flex flex-col gap-4"
          >
          {/* Revisions, then the email log. The order forms used to sit
              between them, which is how a manager came to find the one
              thing the workshop needs filed under "History" -- a word that
              promises a record of what happened, not a job to do. */}
          {history ? (
            <RevisionsSection
              revisions={history.revisions}
              documentId={document.id}
              currency={document.currency}
              currencySymbol={document.currencySymbol}
            />
          ) : null}

          {history ? <EmailHistorySection emails={history.emails} /> : null}
          </div>

          {/* Order forms: what the workshop builds from, and only a FINAL
              quote has any. The tab itself only exists then -- see
              `builderTabsFor` -- so this panel is never rendered empty. */}
          {builderTabs.includes("forms") ? (
            <div
              role="tabpanel"
              id="builder-panel-forms"
              aria-labelledby="builder-tab-forms"
              hidden={tab !== "forms"}
              className="flex flex-col gap-4"
            >
              {formsDocument ? <ProductionFormsSection document={formsDocument} /> : null}
            </div>
          ) : null}
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
                    place. The over-the-cap message was already here, and a
                    second card above it carrying the rest -- in its own
                    visual language, behind its own heading, under a
                    progress meter -- meant the answer to "why can't I
                    finalise this" was split across two boxes that did not
                    look related. */}
                {capMessageText ? <ConcessionCapBadge message={capMessageText} /> : null}
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
          <Link
            href={`/quotes/${document.id}/quotation`}
            aria-label="Preview the quotation"
            className={actionIconClass}
          >
            <Eye className="size-4" aria-hidden="true" />
          </Link>
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
