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
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { resolveQuoteDocuments } from "@/lib/quotation-data";
import { catalogVisibilityUserId } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { getQuoteValidityDays, getShowOptionIcons } from "@/lib/queries/settings";
import { getSpecImages } from "@/lib/queries/spec-images";
import { getUser } from "@/lib/queries/users";
import { canAuthorSign, canRevoke, canSendToClient, signingStatusLabel } from "@/lib/signing/state";
import { concessionCapMessage, markupCapMessage } from "@/lib/pricing";
import { formatDateAU } from "@/lib/format";
import { renderStoredRichText } from "@/lib/rich-text";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";
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
import { DocumentTotals, StickyFooter } from "@/components/builder/sticky-footer";
import { FinalizeButton } from "@/components/builder/finalize-button";
import { UnfinalizeButton } from "@/components/builder/unfinalize-button";
import { SignButton } from "@/components/builder/sign-button";
import { SendToClientButton } from "@/components/builder/send-to-client-button";
import { RevokeSigningLinkButton } from "@/components/builder/revoke-signing-link-button";
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
    getSpecImages("screenSide"),
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

  const title = document.company?.name ?? "New quote";
  const description = `Quote · ${document.number ?? "draft"}${!isDraft ? " — final and read-only" : ""}`;

  return (
    <div className="flex flex-col gap-6 pb-4">
      <PageHeader backHref="/quotes" title={title} description={description} />

      <SigningPanel document={document} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ClientSection
            documentId={document.id}
            companies={companies}
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

          <SectionCard title="Discounts">
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
                  currencySymbol={document.currencySymbol}
                  commission={document.commission}
                />
              </div>
              <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
                <DocumentActions
                  document={document}
                  isDraft={isDraft}
                  isAdmin={isAdmin}
                  mySignatureUrl={mySignatureUrl}
                />
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
            <DocumentActions
              document={document}
              isDraft={isDraft}
              isAdmin={isAdmin}
              mySignatureUrl={mySignatureUrl}
            />
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
        currencySymbol={document.currencySymbol}
        commission={document.commission}
      />
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

        {document.signingStatus === "SIGNED" ? (
          <a
            href={`/api/quotes/${document.id}/signed-pdf`}
            className="focus-ring inline-flex w-fit items-center gap-1.5 rounded text-sm font-medium text-brand underline underline-offset-2"
          >
            {/* Eye, not Download: the route serves `Content-Disposition:
                inline` (src/app/api/quotes/[documentId]/signed-pdf/route.ts),
                so the browser opens this rather than saving a file -- same
                icon this page already uses for "Quotation preview" below,
                which opens in-app rather than downloading for the same
                reason. Download stays reserved for the one link that
                actually triggers a save ("Quotation PDF", `attachment`). */}
            <Eye className="size-4" aria-hidden="true" />
            View signed PDF
          </a>
        ) : null}
      </div>
    </SectionCard>
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
    hasAuthorSignature: document.signatures.some((s) => s.role === "AUTHOR"),
    contactEmail,
  });
  return (
    <div className="flex flex-col gap-2">
      {isDraft ? (
        <FinalizeButton documentId={document.id} />
      ) : (
        <>
          {/* Signing is offered to whoever this page already scoped the
              document to (its author, or any admin — see
              `signQuoteAsAuthor`'s own `documentWhereForUser` check),
              independently of Unfinalize staying admin-only below. Gated on
              `canAuthorSign` — the same function the action itself checks —
              rather than "any FINAL document": nothing sets `signingStatus`
              away from NOT_SENT yet, so this is currently a no-op, but it
              stops the button from being shown (and refused) once
              sending/revoking/declining exist. */}
          {canAuthorSign(document.signingStatus) ? (
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
      {!isDraft && isAdmin ? <UnfinalizeButton documentId={document.id} /> : null}

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
