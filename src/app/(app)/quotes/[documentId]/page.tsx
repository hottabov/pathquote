import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { Download, Eye } from "lucide-react";
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
import { listActiveRegions } from "@/lib/queries/catalog";
import { catalogVisibilityUserId } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { getQuoteValidityDays, getShowOptionIcons } from "@/lib/queries/settings";
import { getSpecImages } from "@/lib/queries/spec-images";
import { concessionCapMessage, markupCapMessage } from "@/lib/pricing";
import { renderStoredRichText } from "@/lib/rich-text";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { ClientSection } from "@/components/builder/client-section";
import { HeroImageSection } from "@/components/builder/hero-image-section";
import { ItemsSection } from "@/components/builder/items-section";
import { ExtraLinesSection } from "@/components/builder/extra-lines-section";
import { DocumentDiscountField } from "@/components/builder/document-discount-field";
import { PriceDisplayToggles } from "@/components/builder/price-display-toggles";
import { NotesSection } from "@/components/builder/notes-section";
import { ValidityDaysField } from "@/components/builder/validity-days-field";
import { DeliveryTermsField } from "@/components/builder/delivery-terms-field";
import { ProductionFormsSection } from "@/components/documents/production-forms-section";
import { DocumentTotals, StickyFooter } from "@/components/builder/sticky-footer";
import { FinalizeButton } from "@/components/builder/finalize-button";
import { UnfinalizeButton } from "@/components/builder/unfinalize-button";
import { DeleteDraftButton } from "@/components/builder/delete-draft-button";
import { ConcessionCapBadge } from "@/components/builder/concession-cap-badge";
import { ConcessionCapToast } from "@/components/builder/concession-cap-toast";

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
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  // `requireRegion` rather than a bare `auth()` because this page also has to
  // decide which regions the inline "+ New company" panel may offer — it is
  // the same session, plus the viewer's region (`null` for an admin).
  const { session, regionId } = await requireRegion();

  const document = await getDocumentForBuilder(session.user, documentId);
  // A foreign document (belongs to another manager) resolves to the same
  // `null` as a nonexistent one — never leak which case it was.
  if (!document) notFound();

  const isDraft = document.status === "DRAFT";
  const isAdmin = isAdminRole(session.user.role);

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
    ? concessionCapMessage(document.documentConcession, document.regionName, document.currency)
    : document.documentConcession.exceedsMarkupCap
      ? markupCapMessage(document.documentConcession, document.regionName, document.currency)
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

  const [
    companies,
    catalog,
    showOptionIcons,
    regions,
    orgDefaultValidityDays,
    formsDocument,
    screenSideImages,
    compatibleOptionsEntries,
  ] = await Promise.all([
    listClientPickerCompanies(session.user),
    hiddenCatalogIdsPromise.then((hiddenCatalogIds) =>
      getItemPickerCatalog(document.regionCode, hiddenCatalogIds)
    ),
    getShowOptionIcons(),
    listActiveRegions(),
    getQuoteValidityDays(),
    // Separate, narrower payload (see `productionFormsInclude`) than
    // `document` above -- `ProductionFormsSection` returns `null` itself
    // for anything that isn't FINAL, so no status check is needed here.
    getDocumentForForms(session.user, documentId),
    // The screen-side diagrams (owner: illustrate +Y/-Y rather than
    // leaving it as bare text) — fetched once per page load, same as
    // `showOptionIcons`, and threaded down through ItemsSection/ItemsList
    // to every item's ProductionSpecEditor.
    getSpecImages("screenSide"),
    Promise.all(
      Array.from(compatKeys.entries()).map(
        async ([key, { productId, seriesId }]) =>
          [key, await listCompatibleOptions(productId, seriesId, document.regionId)] as const
      )
    ),
  ]);

  const compatibleOptionsByItemKey: Record<string, CompatibleOption[]> = Object.fromEntries(
    compatibleOptionsEntries
  );

  // Same rule as /clients/new: a manager is offered only their own region,
  // so the inline "new company" form shows it as text rather than a select.
  // The enforcement is still createCompanyInline's assertRegionWritable.
  const offeredRegions = regionId === null ? regions : regions.filter((r) => r.id === regionId);

  // What the panel SHOWS and what it SUBMITS have to be the same region.
  // `defaultRegionCode` seeds `companyForm.regionCode` (its only use in
  // ClientSection — it also feeds the reset on cancel, which is the same
  // seed), and for a manager the field is now static text reading
  // `offeredRegions[0]`. Those two normally agree, because a document's
  // region is snapshotted from its author's at creation; they diverge when
  // an admin moves a manager to another region after that manager's quotes
  // exist. Seeding from the offered region keeps display and submission in
  // step and matches what the guard will actually accept. An admin
  // (`regionId === null`) is unaffected: full list, working select, still
  // defaulted to the document's own region.
  //
  // The `??` fallback is no longer a route a manager can walk into:
  // `requireRegion` now redirects anyone whose region is missing, deleted or
  // deactivated, so a manager who reaches this line has exactly one offered
  // region. It stays for the one case that outlives that guard — its check
  // and `listActiveRegions()` are two separate reads, so a region
  // deactivated between them would leave `offeredRegions` empty on a
  // request already past the redirect — and because seeding "" latches the
  // panel's Create button disabled with no control to fix it. It is a floor
  // under a race, not the manager-without-an-active-region case it used to
  // describe.
  const defaultRegionCode =
    regionId === null ? document.regionCode : (offeredRegions[0]?.code ?? document.regionCode);

  // Sanitized here rather than inside `NotesSection`, which renders it through
  // `dangerouslySetInnerHTML`: `Document.notes` is a raw column that may
  // predate the write-boundary allowlist (`setDocumentNotes`), so the
  // read-side pass is not optional — but there is no reason for it to happen
  // in the browser, where it costs every visitor the DOMPurify bundle and
  // leaves the page's safety resting on code that shares a runtime with
  // whatever the markup itself might do. See `NotesSection`'s doc comment for
  // why only the read-only branch needs this and the editor branch does not.
  const notesHtml = document.notes ? renderStoredRichText(document.notes) : null;

  const title = document.company?.name ?? "New quote";
  const description = `Quote · ${document.number ?? "draft"}${!isDraft ? " — final and read-only" : ""}`;

  return (
    <div className="flex flex-col gap-6 pb-4">
      <PageHeader backHref="/quotes" title={title} description={description} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ClientSection
            documentId={document.id}
            companies={companies}
            initialCompanyId={document.company?.id ?? null}
            initialContactId={document.contactId}
            regions={offeredRegions.map((r) => ({ code: r.code, name: r.name }))}
            defaultRegionCode={defaultRegionCode}
            readOnly={!isDraft}
          />

          <ItemsSection
            documentId={document.id}
            items={document.items}
            currency={document.currency}
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
            readOnly={!isDraft}
          />

          <SectionCard title="Discounts">
            <DocumentDiscountField
              documentId={document.id}
              discountMode={document.discountMode}
              discountValue={document.discountValue}
              currency={document.currency}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* An export sale collected at the factory door is not a domestic
              taxable supply (the meeting question left unanswered: "What if
              there's no GST? If it's Ex Works?") — this is what lets a quote
              show no tax without hand-editing the tax rate. */}
          <SectionCard title="Delivery terms">
            <DeliveryTermsField
              documentId={document.id}
              deliveryTerms={document.deliveryTerms}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* Per-quote validity override (owner: "What's your capex process?
              ... I'll give you eight [weeks]") — placed next to Notes since
              both are small document-level fields with no pricing effect.
              Defaults to the org-wide setting (/settings) when the document
              has no override of its own. */}
          <SectionCard title="Quote validity">
            <ValidityDaysField
              documentId={document.id}
              validityDays={document.validityDays}
              orgDefaultDays={orgDefaultValidityDays}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* Freeform remarks carried through to whichever renderer the
              document uses (see NotesSection's doc comment). */}
          <SectionCard title="Notes">
            <NotesSection
              documentId={document.id}
              notes={document.notes}
              notesHtml={notesHtml}
              readOnly={!isDraft}
            />
          </SectionCard>

          {/* The setup image: one photo of the whole configuration together
              (usually already drawn up in SketchUp and shown to the
              customer), printed full-width on the quotation's first page —
              see HeroImageSection's own doc comment. */}
          <SectionCard
            title="Setup image"
            description="A photo of the finished configuration, shown full width on the quotation's first page."
          >
            <HeroImageSection
              documentId={document.id}
              heroImageUrl={document.heroImageUrl}
              readOnly={!isDraft}
            />
          </SectionCard>

          <SectionCard title="Quotation pricing display">
            <PriceDisplayToggles
              documentId={document.id}
              showItemPrices={document.showItemPrices}
              showOptionPrices={document.showOptionPrices}
              readOnly={!isDraft}
            />
          </SectionCard>

          {formsDocument ? <ProductionFormsSection document={formsDocument} /> : null}
        </div>

        {/* Desktop/tablet-lg summary: sticky so it stays visible while the
            left column's sections scroll. Hidden below lg — the mobile
            equivalent is the plain (non-sticky) block further down plus the
            sticky totals bar at the very bottom of the viewport. */}
        <aside className="hidden lg:sticky lg:top-6 lg:col-span-1 lg:block">
          <SectionCard title="Summary">
            <div className="flex flex-col gap-4">
              <DocumentSummaryHeader document={document} />
              {capMessageText ? <ConcessionCapBadge message={capMessageText} /> : null}
              <div className="border-t border-slate-100 pt-4">
                <DocumentTotals
                  taxName={document.taxName}
                  taxRate={document.taxRate}
                  subtotal={document.summarySubtotal}
                  discountAmount={document.summaryDiscountAmount}
                  taxAmount={document.taxAmount}
                  total={document.total}
                  currency={document.currency}
                  commission={document.commission}
                />
              </div>
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
                <DocumentActions document={document} isDraft={isDraft} isAdmin={isAdmin} />
              </div>
              {isDraft ? (
                <div className="border-t border-slate-100 pt-4">
                  <DeleteDraftButton documentId={document.id} />
                </div>
              ) : null}
            </div>
          </SectionCard>
        </aside>
      </div>

      {/* Mobile/tablet: status, number and the same action stack as a plain
          block (totals stay exclusively in the sticky bar below so they're
          never shown twice on the same screen). */}
      <div className="lg:hidden">
        <SectionCard title="Status & actions">
          <div className="flex flex-col gap-4">
            <DocumentSummaryHeader document={document} />
            {capMessageText ? <ConcessionCapBadge message={capMessageText} /> : null}
            <DocumentActions document={document} isDraft={isDraft} isAdmin={isAdmin} />
          </div>
        </SectionCard>
      </div>

      {/* Mounted once, renders nothing visible — see its own doc comment.
          ADMIN-only: a MANAGER's save that would cross the cap is rejected
          outright, so a MANAGER's own actions can never produce the
          within-cap -> over-cap transition this toasts. */}
      {isAdmin ? (
        <ConcessionCapToast exceedsCap={capExceeded} message={capMessageText} />
      ) : null}

      <StickyFooter
        documentId={document.id}
        status={document.status}
        taxName={document.taxName}
        taxRate={document.taxRate}
        subtotal={document.summarySubtotal}
        discountAmount={document.summaryDiscountAmount}
        taxAmount={document.taxAmount}
        total={document.total}
        currency={document.currency}
        commission={document.commission}
      />
    </div>
  );
}

function DocumentSummaryHeader({ document }: { document: DocumentForBuilder }) {
  const isDraft = document.status === "DRAFT";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <StatusBadge tone={STATUS_TONE[document.status]}>{isDraft ? "Draft" : "Final"}</StatusBadge>
        {document.number ? (
          <span className="font-mono text-sm text-slate-600">{document.number}</span>
        ) : null}
      </div>
    </div>
  );
}

const actionLinkClass =
  "focus-ring flex h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white text-sm font-medium text-brand-dark transition-colors md:hover:bg-slate-50";

function DocumentActions({
  document,
  isDraft,
  isAdmin,
}: {
  document: DocumentForBuilder;
  isDraft: boolean;
  isAdmin: boolean;
}) {
  // The quotation (content-block-driven, Phase 6) is the only customer-
  // facing rendering of a document now — the older plain line-item
  // "Summary" sheet/PDF was removed (owner: "нам не потрібно мати Summary.
  // Тільки повний quotation.").
  return (
    <div className="flex flex-col gap-2">
      {isDraft ? (
        <FinalizeButton documentId={document.id} />
      ) : isAdmin ? (
        <UnfinalizeButton documentId={document.id} />
      ) : null}

      <Link href={`/quotes/${document.id}/quotation`} className={actionLinkClass}>
        <Eye className="size-4" aria-hidden="true" />
        Quotation preview
      </Link>

      <a href={`/api/quotes/${document.id}/quotation-pdf`} className={actionLinkClass}>
        <Download className="size-4" aria-hidden="true" />
        Quotation PDF
      </a>
    </div>
  );
}
