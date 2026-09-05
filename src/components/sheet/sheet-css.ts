/**
 * The quotation sheet's entire stylesheet, as a plain string embedded in a
 * `<style>` element by `QuotationSheet` itself.
 *
 * It lives in its own module rather than beside the markup because it is the
 * single largest thing in the sheet and shares nothing with the JSX but the
 * class names — keeping it here means a change to one section's markup and a
 * change to the sheet's visual language are separate edits to separate files.
 * It stays a string (not a CSS file) for the reason the sheet has no Tailwind
 * classes either: Gotenberg's headless Chromium only ever sees the HTML
 * string posted to it, never this app's compiled stylesheet, so every rule
 * the printed page needs has to travel inside that string.
 *
 * Brand colors per the PathQuote style guide: #243478 (primary/header rule),
 * #00B8E2 (accent), #2B304F (dark text/headings) — matching
 * --color-brand/--color-brand-accent/--color-brand-dark in
 * src/app/globals.css, but hardcoded here since this markup never has that
 * stylesheet available.
 */
export const SHEET_CSS = `
  .pq-sheet {
    position: relative;
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto;
    background: #ffffff;
    color: #1a1a1a;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    box-sizing: border-box;
  }
  .pq-sheet * {
    box-sizing: border-box;
  }
  .pq-content {
    position: relative;
    z-index: 1;
    padding: 15mm;
  }
  .pq-watermark {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-30deg);
    font-size: 90px;
    font-weight: 700;
    letter-spacing: 10px;
    color: rgba(43, 48, 79, 0.08);
    white-space: nowrap;
    z-index: 0;
    pointer-events: none;
  }
  .pq-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 12px;
    border-bottom: 3px solid #243478;
  }
  .pq-logo-img {
    max-width: 180px;
    max-height: 64px;
    object-fit: contain;
  }
  .pq-header-entity {
    text-align: right;
  }
  .pq-entity-name {
    font-size: 14px;
    font-weight: 700;
    color: #2b304f;
  }
  .pq-entity-line {
    color: #444444;
  }
  .pq-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-top: 18px;
  }
  .pq-title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 2px;
    color: #243478;
  }
  .pq-meta {
    text-align: right;
  }
  .pq-meta-row {
    color: #333333;
  }
  .pq-meta-label {
    color: #777777;
  }
  /* "Prepared for" / "Prepared by" header row (owner reference doc) — two
     columns sharing the same box styling .pq-client always had; the row
     wrapper now carries the top margin that single box used to. */
  .pq-prepared-row {
    display: flex;
    gap: 16px;
    margin-top: 18px;
  }
  /* Delivery address row (see the JSX comment above) — same box styling as
     .pq-client, just full-width and stacked below the prepared-for/by row
     instead of sharing its two-column flex. */
  .pq-delivery-row {
    margin-top: 12px;
  }
  .pq-client {
    flex: 1;
    min-width: 0;
    padding: 10px 12px;
    border-left: 3px solid #00b8e2;
    background: #f7fbfd;
  }
  .pq-client-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #00b8e2;
  }
  .pq-client-name {
    font-size: 13px;
    font-weight: 700;
    color: #2b304f;
    margin-top: 2px;
  }
  .pq-client-line {
    color: #444444;
  }
  .pq-client-contact {
    margin-top: 4px;
  }
  /* "Prepared by" photo (see the JSX above) — sits at the right edge of the
     block, opposite the name/phone/email text; only rendered when the
     author has one, and nothing reserves its space otherwise (no
     placeholder, no extra gap). */
  .pq-prepared-by-client {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  .pq-prepared-by-avatar {
    width: 100px;
    height: 100px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
  }
  /* The setup image (see the JSX comment above) — full content width, a
     bounded height so one oversized upload can't push the price banner off
     the first page, and object-fit: cover so it fills that box cleanly
     regardless of the photo's own aspect ratio. No border/frame/caption by
     design — it should read as part of the page, not a bolted-on photo. */
  .pq-hero-image {
    display: block;
    width: 100%;
    max-height: 320px;
    object-fit: cover;
    border-radius: 6px;
    margin-top: 18px;
  }
  .pq-total-banner {
    margin-top: 18px;
    padding: 14px 16px;
    border-radius: 6px;
    background: #243478;
    color: #ffffff;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-total-banner-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: #b9c2e8;
  }
  .pq-total-banner-amount {
    font-size: 18px;
    font-weight: 700;
  }
  .pq-total-banner-note {
    font-size: 10px;
    color: #b9c2e8;
  }
  /* The expiry sits on the dark banner beside the muted "(incl. GST)" note,
     but is not a footnote — it carries the deadline, so it gets full white
     and its own weight. Pushed to the end of the flex row so it reads as a
     statement of its own rather than a continuation of the tax note. */
  .pq-total-banner-validity {
    margin-left: auto;
    font-size: 13px;
    font-weight: 700;
    color: #ffffff;
  }
  .pq-section {
    margin-top: 28px;
  }
  .pq-section-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: #243478;
    border-bottom: 2px solid #243478;
    padding-bottom: 6px;
    margin: 0 0 14px 0;
    /* Never let a section heading render as the last line on a page with
       its own content pushed to the next one. */
    page-break-after: avoid;
    break-after: avoid;
  }
  /* Each machine/equipment item's whole write-up (title block + its option
     blocks) is the page-break-avoidance unit, same idea as .pq-item-group
     below for the investment summary table — "where reasonable" per the
     plan, since a very long write-up can still legitimately span a page in
     Chromium's printed output. */
  .pq-machine-section {
    page-break-inside: avoid;
    break-inside: avoid;
    margin-bottom: 20px;
    padding-top: 16px;
    border-top: 1px solid #e0e4f0;
  }
  /* No separator above the very first item — the total banner above it
     already provides the visual break. */
  .pq-machine-section:first-child {
    padding-top: 0;
    border-top: none;
  }
  .pq-machine-section:last-child {
    margin-bottom: 0;
  }
  .pq-title-image-group {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-machine-image {
    display: block;
    width: 100%;
    height: auto;
    max-height: 9cm;
    object-fit: contain;
    margin-top: 10px;
  }
  /* Unified options table (owner: "table with small icons — more control
     than a list") — one row per selected OPTION line, whether or not its
     code matched an option.* content block (see QuotationOptionRow), so a
     block-rendered option and an unmatched one finally share one consistent
     look instead of drifting (prose paragraphs vs. bold indented bullets). */
  .pq-options-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    margin-top: 10px;
  }
  .pq-opt-col-icon {
    width: 34px;
  }
  .pq-opt-col-option {
    width: auto;
  }
  .pq-opt-col-qty {
    width: 50px;
    text-align: center;
  }
  .pq-opt-col-price {
    width: 70px;
    text-align: right;
  }
  .pq-options-table thead th {
    text-align: left;
    font-size: 8.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888888;
    border-bottom: 1px solid #d8dcec;
    padding: 4px;
  }
  .pq-options-table thead th.pq-opt-col-qty {
    text-align: center;
  }
  .pq-options-table thead th.pq-opt-col-price {
    text-align: right;
  }
  .pq-options-table td {
    padding: 5px 4px;
    vertical-align: top;
    border-bottom: 1px solid #eeeeee;
    /* One option row is a page-break-avoidance unit of its own (a table row
       can't itself declare avoid in all print engines, but Chromium honours
       it on the row) — a short icon+name+description group should never
       split across a page boundary. */
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-options-table tbody tr:last-child td {
    border-bottom: none;
  }
  .pq-option-icon {
    display: block;
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
  .pq-option-name {
    font-weight: 700;
    color: #2b304f;
  }
  .pq-option-code {
    font-family: "Courier New", Courier, monospace;
    font-weight: 400;
    color: #888888;
  }
  /* The machine's own row heads its options table. A heavier rule underneath
     separates the product from what was added to it, so the list reads as
     "this, plus these" rather than as one flat run of options. */
  .pq-base-row td {
    border-bottom: 1px solid #d5d8e4 !important;
  }
  .pq-base-row .pq-opt-col-price {
    font-weight: 700;
  }
  .pq-option-desc {
    margin-top: 2px;
    color: #666666;
    font-size: 9.5px;
  }
  .pq-option-desc.pq-block-body p {
    margin: 0 0 4px 0;
  }
  .pq-option-desc.pq-block-body p:last-child {
    margin-bottom: 0;
  }
  .pq-option-attrs {
    margin-top: 2px;
    color: #888888;
    font-size: 9px;
  }
  .pq-opt-col-qty {
    color: #555555;
  }
  .pq-block-missing {
    color: #333333;
  }
  /* Section heading — one consistent tier for EVERY machine/equipment/
     software/service section (owner: "every item section must have a
     consistent prominent heading"), rendered explicitly outside the
     admin-authored block body rather than relying on that body carrying its
     own markdown heading (fragile — most content blocks never did; see
     src/lib/quotation-data.ts's sectionTitle computation). Same size/weight/color tier
     as .pq-block-body h1/h2 and .pq-section-title, so a product/section name
     is unmistakable at a glance. */
  .pq-product-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: #243478;
    margin: 0 0 6px 0;
    page-break-after: avoid;
    break-after: avoid;
  }
  /* Structural section price row (owner: every item section must show its
     price) — same tier every section gets, right under the heading,
     regardless of whether a content block matched (see
     src/lib/quotation-data.ts's sectionPrice/hasInlinePrice). */
  .pq-section-price {
    margin: 0 0 6px 0;
    color: #243478;
    font-weight: 700;
  }
  .pq-auto-summary-spec {
    margin-top: 4px;
    color: #444444;
    font-weight: 400;
  }
  .pq-flow-block {
    margin-bottom: 16px;
  }
  .pq-flow-block:last-child {
    margin-bottom: 0;
  }
  .pq-block-title {
    font-size: 12px;
    font-weight: 700;
    color: #2b304f;
    margin: 0 0 4px 0;
    page-break-after: avoid;
    break-after: avoid;
  }
  .pq-conditions-section .pq-block-body {
    font-size: 10px;
    color: #444444;
  }
  .pq-block-body {
    color: #333333;
  }
  .pq-block-body p {
    margin: 0 0 8px 0;
  }
  .pq-block-body p:last-child {
    margin-bottom: 0;
  }
  /* Top-level block heading (e.g. machine.m-series's "## Pathfinder {{model}}
     Cutting System", rsp.agreement's "## Pathfinder Remote Support Program")
     — same size/weight/color tier as .pq-section-title and
     .pq-auto-summary-name so a product/section name is unmistakable at a
     glance rather than blending into the body text underneath it, and never
     orphaned from the content it introduces across a page break. */
  .pq-block-body h1,
  .pq-block-body h2 {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: #243478;
    margin: 12px 0 8px 0;
    page-break-after: avoid;
    break-after: avoid;
  }
  .pq-block-body h1:first-child,
  .pq-block-body h2:first-child {
    margin-top: 0;
  }
  /* Sub-heading within a block (e.g. "### Software", "### Accessories") —
     one tier down, matching .pq-block-title's size/color so the hierarchy
     stays consistent across every content-block section. */
  .pq-block-body h3 {
    font-size: 12px;
    font-weight: 700;
    color: #2b304f;
    margin: 10px 0 6px 0;
    page-break-after: avoid;
    break-after: avoid;
  }
  .pq-block-body h3:first-child {
    margin-top: 0;
  }
  .pq-block-body ul {
    margin: 0 0 8px 0;
    padding-left: 18px;
  }
  .pq-block-body ul:last-child {
    margin-bottom: 0;
  }
  .pq-block-body strong {
    color: #2b304f;
  }
  .pq-items {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    margin-top: 12px;
  }
  .pq-items thead th {
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #2b304f;
    border-bottom: 2px solid #243478;
    padding: 6px 4px;
  }
  .pq-items thead th.pq-col-qty,
  .pq-items thead th.pq-col-amount {
    text-align: right;
  }
  .pq-col-item {
    width: 60%;
  }
  .pq-col-qty {
    width: 22%;
    text-align: right;
  }
  .pq-col-amount {
    width: 18%;
    text-align: right;
  }
  .pq-items td {
    padding: 6px 4px;
    vertical-align: top;
    border-bottom: 1px solid #e4e4e4;
  }
  .pq-item-row td {
    padding-top: 10px;
  }
  .pq-item-group {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-item-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .pq-thumb {
    width: 60px;
    height: 60px;
    object-fit: contain;
    border: 1px solid #e4e4e4;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .pq-item-name {
    font-weight: 700;
    color: #2b304f;
  }
  .pq-item-code {
    font-family: "Courier New", Courier, monospace;
    font-weight: 400;
    color: #888888;
    font-size: 10px;
  }
  .pq-item-desc {
    color: #666666;
    font-size: 10px;
    margin-top: 2px;
  }
  .pq-item-desc.pq-block-body p {
    margin: 0 0 4px 0;
  }
  .pq-item-desc.pq-block-body p:last-child {
    margin-bottom: 0;
  }
  .pq-option-row td {
    border-bottom: none;
    padding-top: 3px;
    padding-bottom: 3px;
  }
  .pq-option-indent {
    padding-left: 18px !important;
  }
  .pq-option-name {
    color: #333333;
  }
  .pq-option-desc {
    color: #888888;
    font-size: 9.5px;
  }
  .pq-discount-row td {
    border-bottom: none;
    padding-top: 0;
    padding-bottom: 8px;
    color: #b45309;
    font-style: italic;
    font-size: 10px;
  }
  /* Per-item subtotal row (base + options, less the item discount — owner:
     "base price per item + options listed, totals at bottom" replacing the
     old lump-sum item-row amount) — small and muted, distinct from both the
     plain option rows above it and the document-level totals block below
     the table. */
  .pq-item-subtotal-row td {
    border-bottom: none;
    padding-top: 2px;
    padding-bottom: 8px;
    color: #555555;
    font-weight: 700;
    font-size: 10px;
  }
  .pq-amount {
    text-align: right;
    white-space: nowrap;
  }
  /* A negative extra line (trade-in) — muted and italic so its amount
     reads distinctly from an ordinary charge, never mistaken for one. */
  .pq-negative {
    color: #64748b;
    font-style: italic;
  }
  .pq-totals {
    width: 60%;
    margin-left: auto;
    margin-top: 12px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-totals-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    color: #333333;
    border-bottom: 1px solid #eeeeee;
  }
  .pq-totals-final {
    margin-top: 4px;
    border-bottom: none;
    border-top: 2px solid #243478;
    font-size: 14px;
    font-weight: 700;
    color: #243478;
  }
  .pq-rsp-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 14px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-rsp-table th {
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #2b304f;
    border-bottom: 2px solid #243478;
    padding: 6px 4px;
  }
  .pq-rsp-table td {
    padding: 6px 4px;
    border-bottom: 1px solid #e4e4e4;
    color: #333333;
  }
  .pq-footer {
    margin-top: 28px;
    padding-top: 12px;
    border-top: 1px solid #e4e4e4;
    display: flex;
    justify-content: space-between;
    gap: 24px;
    font-size: 10px;
    color: #555555;
  }
  .pq-bank {
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-bank-title {
    font-weight: 700;
    color: #2b304f;
    margin-bottom: 3px;
  }
  .pq-bank-label {
    color: #888888;
  }
  .pq-footer-text {
    max-width: 60%;
    color: #777777;
    white-space: pre-line;
  }
  .pq-signatures {
    margin-top: 40px;
    display: flex;
    gap: 60px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .pq-sig-block {
    flex: 1;
  }
  .pq-sig-line {
    border-top: 1px solid #333333;
    height: 32px;
  }
  .pq-sig-label {
    margin-top: 4px;
    font-size: 10px;
    color: #555555;
  }
`;
