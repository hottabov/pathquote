import type { QuotationData } from "@/lib/quotation-data";
import { SHEET_CSS } from "@/components/sheet/sheet-css";
import { ConditionsSection } from "@/components/sheet/sections/conditions-section";
import { DocumentHeader } from "@/components/sheet/sections/document-header";
import { EntityFooter } from "@/components/sheet/sections/entity-footer";
import { EquipmentDetail } from "@/components/sheet/sections/equipment-detail";
import { InvestmentSummary } from "@/components/sheet/sections/investment-summary";
import { NotesSection } from "@/components/sheet/sections/notes-section";
import { PreparedBlock } from "@/components/sheet/sections/prepared-block";
import { RspSection } from "@/components/sheet/sections/rsp-section";
import { SetupImage } from "@/components/sheet/sections/setup-image";
import { Signatures } from "@/components/sheet/sections/signatures";
import { TermsSection } from "@/components/sheet/sections/terms-section";
import { TotalBanner } from "@/components/sheet/sections/total-banner";

/**
 * The extended quotation sheet (Phase 6): a single, self-contained render of
 * a QUOTE's full content-block-driven detail — cover header, one section per
 * machine/equipment item with its admin-authored description and selected
 * options rendered from markdown, an investment summary table, terms,
 * general conditions, the RSP agreement + coverage table, and signatures.
 * Used by both the `/documents/[documentId]/quotation` preview route and,
 * via src/lib/pdf.ts's `renderQuotationHtml`, the quotation PDF pipeline —
 * that second consumer is why this file is deliberately NOT a normal app
 * component: no Tailwind classes (Gotenberg's headless Chromium never sees
 * this app's compiled stylesheet — only whatever HTML string is actually
 * posted to it), no data fetching, no `async`, everything this markup needs
 * lives in the one embedded `<style>` block below.
 *
 * This file is the composition root only: it owns the page shell (watermark,
 * stylesheet, content padding) and the order the sections appear in, while
 * each section's markup lives in its own module under `sections/`. The order
 * of the calls below IS the reading order of the printed quote and is the one
 * thing a reader of this file needs to be able to see at a glance — which is
 * what a single 550-line function no longer let them do. Every section
 * component follows the same rules as this one (no Tailwind, no async, no
 * data work) and decides for itself whether it has anything to render, so a
 * quote missing a whole section simply prints without it.
 *
 * It receives an already-fully-assembled `QuotationData` — see
 * `buildQuotationData` in src/lib/quotation-data.ts, the pure assembler that
 * resolves content blocks, substitutes `{{placeholders}}`, and renders each
 * body to HTML via `renderStoredRichText` (src/lib/rich-text.ts) — and does
 * no further data work of its own, just JSX. Every block body reaches this
 * component as trusted, already-sanitized HTML (`renderStoredRichText`
 * either sanitizes already-HTML content through an allowlist, or runs
 * legacy markdown through `renderMarkdown`, which HTML-escapes its input
 * before any markdown transform runs), so `dangerouslySetInnerHTML` here is
 * safe by construction.
 */
export function QuotationSheet({ data }: { data: QuotationData }) {
  const { totals } = data;
  // `showOptionPrices` implies item totals are visible too (see
  // `QuotationData.showItemPrices`'s doc comment) — every per-item amount
  // in this sheet (the auto-summary price, the investment table's item and
  // extra-line amount columns, the item discount row) is gated on this,
  // while `data.showOptionPrices` alone gates only the option rows. The
  // grand total banner and the totals block below the table are never
  // gated by either flag — the owner's rule is the client always sees the
  // bottom line, only the itemized detail is optional.
  const itemPriceVisible = data.showItemPrices || data.showOptionPrices;
  const optionPriceVisible = data.showOptionPrices;

  return (
    <div className="pq-sheet">
      <style>{SHEET_CSS}</style>

      {data.isDraft ? (
        <div className="pq-watermark" aria-hidden="true">
          DRAFT
        </div>
      ) : null}

      <div className="pq-content">
        <DocumentHeader
          logo={data.logo}
          entity={data.entity}
          number={data.number}
          issueDate={data.issueDate}
          validityDate={data.validityDate}
        />
        <PreparedBlock client={data.client} delivery={data.delivery} preparedBy={data.preparedBy} />
        <SetupImage heroImage={data.heroImage} />
        <TotalBanner totals={totals} validityDate={data.validityDate} />
        <EquipmentDetail sections={data.machineSections} optionPriceVisible={optionPriceVisible} />
        <NotesSection notesHtml={data.notesHtml} />
        <InvestmentSummary
          items={data.items}
          extraLines={data.extraLines}
          totals={totals}
          itemPriceVisible={itemPriceVisible}
        />
        <TermsSection sections={data.termsSections} />
        <ConditionsSection sections={data.conditionsSections} />
        <RspSection rsp={data.rsp} />
        <EntityFooter entity={data.entity} />
        <Signatures showSignature={data.showSignature} />
      </div>
    </div>
  );
}
