/**
 * The production order forms' entire stylesheet, as a plain string embedded
 * in a `<style>` element by `FormSheet`.
 *
 * Same arrangement, and for the same reason, as
 * src/components/sheet/sheet-css.ts: Gotenberg's headless Chromium only ever
 * sees the HTML string posted to it, never this app's compiled stylesheet,
 * so every rule the printed page needs has to travel inside that string.
 *
 * Lifted from the approved mockups in `docs/mockups/*-order-form.html`,
 * which are the visual contract
 * (docs/superpowers/specs/2026-09-03-web-production-forms-design.md §5). Two
 * changes were made on the way in: every class is prefixed `pf-`, so these
 * rules cannot collide with the quotation sheet's or the app's, and the
 * mockups' own page chrome -- toolbar, stage, the screen-only drop shadow --
 * is dropped, since nothing here is ever shown in a browser window.
 *
 * Millimetres throughout. The output is A4; `px` would invite a DPI
 * assumption and `pt` is reserved for type.
 */
export const FORM_SHEET_CSS = `
/* ═══ The sheet — always white paper, never theme-dependent ════════════ */
  .pf-sheet {
    /* Ink */
    --ink:        #16181f;
    --ink-soft:   #4b5162;
    --label:      #6d7488;
    /* Blue-biased neutrals, so the greys sit under the navy rather than beside it */
    --rule:       #c2c7d6;
    --rule-soft:  #dde1ec;
    --tint:       #eef0f7;
    --tint-hit:   #e7ebf7;
    --box-line:   #949ab0;
    --navy:       #243478;
    --alarm:      #a41f1f;
    /* One box size for every tick on the sheet */
    --bx: 3.6mm;

    width: 210mm;
    min-height: 297mm;
    padding: 9mm 11mm 8mm;
    box-sizing: border-box;
    background: #fff;
    color: var(--ink);
    font-family: Arial, Helvetica, "Liberation Sans", sans-serif;
    font-size: 7.8pt;
    line-height: 1.25;
    /* Without this, browsers drop every fill on print: navy boxes, tint bars. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .pf-sheet * { box-sizing: border-box; }

  /* ═══ Masthead ════════════════════════════════════════════════════════ */
  .pf-mast {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 6mm;
    padding-bottom: 2.4mm;
    border-bottom: 0.85mm solid var(--navy);
  }
  /* The wrapper carries the width and the svg inside it fills that: the mark
     is inlined as markup (see logo.ts), so the element being sized is a div,
     not the image itself. (No backticks in this file -- it is one template
     literal, and a stray backtick ends the string.) */
  .pf-mast .pf-logo { width: 46mm; height: auto; display: block; }
  .pf-mast .pf-logo svg { display: block; width: 100%; height: auto; }
  .pf-mast .pf-doctitle {
    font-size: 13pt;
    font-weight: 700;
    letter-spacing: 0.005em;
    line-height: 1.05;
    padding-left: 5mm;
    border-left: 0.25mm solid var(--rule);
  }
  .pf-mast .pf-doctitle small {
    display: block;
    margin-top: 0.6mm;
    font-size: 6.2pt;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--label);
  }
  .pf-contact { text-align: right; font-size: 6.8pt; color: var(--ink-soft); line-height: 1.5; }
  .pf-contact b { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }

  /* ═══ Field primitive ═════════════════════════════════════════════════ */
  .pf-fld { min-width: 0; }
  .pf-lb {
    display: block;
    font-size: 5.9pt;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--label);
    line-height: 1.15;
  }
  .pf-fld > .pf-vl {
    display: block;
    min-height: 4.5mm;
    padding: 0.6mm 0 0.5mm;
    border-bottom: 0.22mm solid var(--rule);
    font-size: 8.6pt;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pf-fld > .pf-vl:empty::after { content: "\\00a0"; }
  .pf-num { font-variant-numeric: tabular-nums; }

  /* Contact data is never abbreviated: an ellipsised email is a wrong email.
     It wraps at any character instead, and only ever needs to when the
     address is genuinely longer than the full content width. */
  .pf-fld > .pf-vl.pf-full {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    overflow-wrap: anywhere;
  }

  /* Several ruled lines under one label — address blocks. Rows sit directly
     on each other so the block reads as one field, not as four fields. */
  .pf-lines { display: block; }
  .pf-lines .pf-ln {
    display: block;
    min-height: 4.5mm;
    padding: 0.6mm 0 0.5mm;
    border-bottom: 0.22mm solid var(--rule);
    font-size: 8.6pt;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pf-lines .pf-ln:empty::after { content: "\\00a0"; }

  .pf-metastrip {
    display: grid;
    grid-template-columns: 2.1fr 1.3fr 1fr;
    gap: 5mm;
    margin-top: 2.8mm;
  }

  /* ═══ Section shell ═══════════════════════════════════════════════════ */
  .pf-sec { margin-top: 3.2mm; break-inside: avoid; }
  .pf-sec > h2 {
    margin: 0 0 2mm;
    padding: 1mm 2mm 1mm 2.4mm;
    background: var(--tint);
    border-left: 0.7mm solid var(--navy);
    font-size: 6.5pt;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--navy);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 4mm;
  }
  .pf-sec > h2 .pf-hint {
    font-weight: 400;
    letter-spacing: 0.02em;
    text-transform: none;
    color: var(--label);
    font-size: 6.4pt;
  }

  .pf-two { display: grid; grid-template-columns: 1.32fr 1fr; gap: 6mm; }

  /* The operator/control-box side: boxes on the left, the diagram of the
     chosen side beside them. Fixed 20mm square so the block is the same
     height on every form whether or not the diagrams are uploaded yet, and
     object-fit so artwork drawn to another aspect is letterboxed rather than
     stretched. */
  .pf-sideblock { display: flex; align-items: flex-start; gap: 3.4mm; }
  .pf-sidefig {
    width: 20mm;
    height: 20mm;
    flex: none;
    object-fit: contain;
    border: 0.3mm solid var(--rule);
    border-radius: 1mm;
    background: #fff;
  }
  .pf-stack { display: grid; gap: 1.6mm; }
  .pf-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 4mm; }

  /* ═══ Ticks — one box size everywhere ═════════════════════════════════ */
  .pf-tick {
    display: grid;
    grid-template-columns: var(--bx) 1fr;
    align-items: start;
    gap: 1.8mm;
    font-size: 7.6pt;
    line-height: 1.22;
  }
  .pf-tick .pf-bx {
    width: var(--bx);
    height: var(--bx);
    flex: none;
    border: 0.26mm solid var(--box-line);
    border-radius: 0.5mm;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pf-tick.pf-on .pf-bx { background: var(--navy); border-color: var(--navy); }
  /* Checkmark: two borders on a rotated box, optically centred by the
     translate — a glyph would depend on a font that may not exist in the
     PDF renderer, and a background-image is dropped by some print paths. */
  .pf-tick .pf-bx::after {
    content: "";
    width: 1.05mm;
    height: 2.0mm;
    border: solid #fff;
    border-width: 0 0.4mm 0.4mm 0;
    transform: translateY(-0.28mm) rotate(43deg);
    visibility: hidden;
  }
  .pf-tick.pf-on .pf-bx::after { visibility: visible; }
  .pf-tick .pf-tx { padding-top: 0.35mm; }
  .pf-tick .pf-code { font-weight: 700; }
  .pf-tick .pf-desc { color: var(--ink-soft); }
  .pf-tick.pf-on .pf-code, .pf-tick.pf-on .pf-tx { font-weight: 700; }
  .pf-tick.pf-on .pf-desc { color: var(--ink); font-weight: 400; }
  /* Emphasised text only — the box stays the same size as every other box.
     Single-line, so the box centres on the text rather than hanging at its top. */
  .pf-tick.pf-lead { font-size: 8.8pt; align-items: center; }
  .pf-tick.pf-lead .pf-tx { padding-top: 0; }

  /* ═══ Option grid ═════════════════════════════════════════════════════ */
  .pf-opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6mm 0; }
  .pf-opts.pf-four { grid-template-columns: repeat(4, 1fr); gap: 1.4mm 3mm; }
  /* Row gap stays tight: these wrap in a half-width column, and a 7mm row
     gap turned two wrapped lines into a hole. */
  .pf-opts.pf-row { display: flex; gap: 1.2mm 6mm; flex-wrap: wrap; }
  /* Single column. grid-template-columns has to be reset explicitly — .pf-opts
     sets repeat(3, 1fr) and .pf-col only overrode display and gap, which left
     the two choices sitting side by side. */
  .pf-opts.pf-col {
    display: grid;
    grid-template-columns: 1fr;
    justify-items: start;
    gap: 1.2mm;
  }
  .pf-opts.pf-five { grid-template-columns: repeat(5, 1fr); gap: 1.4mm 3mm; }

  /* Padding lives on the cell so the hit tint reads as a full row band. */
  .pf-opts > .pf-tick { padding: 0.85mm 2.5mm; border-radius: 0.7mm; }
  .pf-opts > .pf-tick.pf-on { background: var(--tint-hit); }

  /* PathWorks modules: code on top, name under it — the code is what the
     workshop matches against, the name is what a reader needs once. */
  .pf-opts.pf-stacked > .pf-tick { align-items: start; }
  .pf-opts.pf-stacked .pf-code { display: block; }
  .pf-opts.pf-stacked .pf-desc { display: block; font-size: 6.8pt; line-height: 1.2; }

  /* Two sections sharing one band, when neither fills a row on its own. */
  .pf-secrow { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; align-items: start; }
  .pf-secrow > .pf-sec { margin-top: 0; }

  /* ═══ Interface-side diagram (lifted from the original workbook) ═══════ */
  /* Columns are content-sized, not 1fr: a stretched second column made the
     diagram grow to fill the row and pushed the Options section onto page 2. */
  .pf-uiblock {
    display: grid;
    grid-template-columns: auto auto;
    justify-content: start;
    gap: 5mm;
    align-items: center;
  }
  .pf-uiblock img {
    display: block;
    height: 64px;
    width: auto;
    max-width: 100%;
    border: 0.22mm solid var(--rule);
    border-radius: 0.8mm;
  }

  /* ═══ Inline measured value ═══════════════════════════════════════════ */
  .pf-inlinefld { display: inline-flex; align-items: baseline; gap: 1.5mm; }
  .pf-inlinefld .pf-run {
    min-width: 15mm;
    border-bottom: 0.22mm solid var(--rule);
    text-align: center;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    padding: 0 1mm 0.3mm;
  }
  .pf-inlinefld .pf-unit { font-size: 6.8pt; color: var(--label); text-transform: uppercase; letter-spacing: 0.08em; }

  /* ═══ Write-in blocks ═════════════════════════════════════════════════ */
  .pf-writein {
    border: 0.22mm solid var(--rule);
    border-radius: 1mm;
    padding: 1.6mm 2.2mm 2mm;
    min-height: 14mm;
  }
  .pf-writein .pf-lb { margin-bottom: 1.1mm; }
  .pf-writein .pf-body { font-size: 8.4pt; line-height: 1.35; }
  .pf-warn {
    display: inline-block;
    margin-left: 1.6mm;
    padding: 0.25mm 1.3mm;
    border-radius: 0.7mm;
    background: #fbe9e9;
    color: var(--alarm);
    font-size: 5.8pt;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .pf-yesno { display: flex; gap: 6mm; margin-bottom: 1.4mm; }

  /* ═══ Office use only ═════════════════════════════════════════════════ */
  .pf-office {
    margin-top: 3.6mm;
    border: 0.28mm dashed #a9aec0;
    border-radius: 1mm;
    padding: 2mm 2.8mm 2.8mm;
    background: #fafbfd;
  }
  .pf-office > h2 {
    margin: 0 0 2mm;
    font-size: 6.5pt;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--label);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .pf-office > h2 .pf-hint { font-weight: 400; letter-spacing: 0.02em; text-transform: none; }
  .pf-officegrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2.8mm 6mm; }
  .pf-officegrid .pf-fld > .pf-vl { border-bottom-style: dashed; border-bottom-color: #a9aec0; }
  .pf-sign { grid-column: 1 / -1; display: grid; grid-template-columns: 1.6fr 1fr; gap: 6mm; }
  .pf-sign .pf-fld > .pf-vl { min-height: 7.5mm; }

  /* ═══ Footnote ════════════════════════════════════════════════════════ */
  .pf-footnote {
    margin-top: 2.8mm;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6mm;
    padding-top: 1.5mm;
    border-top: 0.22mm solid var(--rule);
    font-size: 6.2pt;
    color: var(--label);
  }
  .pf-footnote b { color: var(--alarm); }
  .pf-footnote .pf-prov { white-space: nowrap; font-variant-numeric: tabular-nums; }

  /* ═══ Blank-form mode ═════════════════════════════════════════════════ */
  .pf-sheet.pf-blank .pf-vl,
  .pf-sheet.pf-blank .pf-lines .pf-ln,
  .pf-sheet.pf-blank .pf-run,
  .pf-sheet.pf-blank .pf-writein .pf-body { color: transparent; }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-bx { background: #fff; border-color: var(--box-line); }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-bx::after { visibility: hidden; }
  .pf-sheet.pf-blank .pf-opts > .pf-tick.pf-on { background: transparent; }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-code { font-weight: 700; }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-tx { font-weight: 400; }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-desc { color: var(--ink-soft); }

  /* ── from the x-calibre mockup ─────────────────────────────────────────── */
  /* ═══ Masthead — identical on every form in the set ═══════════════════ */
  .pf-mast {
    display: grid; grid-template-columns: auto 1fr auto;
    align-items: center; gap: 6mm;
    padding-bottom: 2.4mm; border-bottom: 0.85mm solid var(--navy);
  }
  .pf-fld > .pf-vl.pf-full {
    white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere;
  }
  .pf-lines { display: block; }
  .pf-secrow { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; align-items: start; }
  .pf-tick .pf-bx::after {
    content: ""; width: 1.05mm; height: 2.0mm;
    border: solid #fff; border-width: 0 0.4mm 0.4mm 0;
    transform: translateY(-0.28mm) rotate(43deg);
    visibility: hidden;
  }
  .pf-tick.pf-lead { font-size: 8.8pt; align-items: center; }
  /* Fitted as standard, not chosen: same mark so the workshop still reads
     "this is on the machine", grey so nobody hunts for who ticked it. */
  .pf-tick.pf-std .pf-bx { background: var(--box-line); border-color: var(--box-line); }
  .pf-tick.pf-std .pf-bx::after { visibility: visible; }
  .pf-tick.pf-std .pf-code { font-weight: 700; }
  .pf-tick.pf-std .pf-desc { color: var(--ink-soft); }
  /* ═══ Option grids ════════════════════════════════════════════════════ */
  .pf-opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6mm 0; }
  .pf-opts.pf-row { display: flex; gap: 1.2mm 6mm; flex-wrap: wrap; }
  .pf-opts.pf-col { display: grid; grid-template-columns: 1fr; justify-items: start; gap: 1.2mm; }
  .pf-opts.pf-one { display: grid; grid-template-columns: 1fr; gap: 0.6mm; }
  .pf-opts > .pf-tick { padding: 0.85mm 2.5mm; border-radius: 0.7mm; }
  .pf-opts > .pf-tick.pf-std { background: var(--tint-std); }
  /* PathWorks modules: code on top, name under it. */
  .pf-opts.pf-stacked > .pf-tick { align-items: start; }
  /* Three named columns, mirroring the printed form's own grouping. */
  .pf-optcols { display: grid; grid-template-columns: 1.35fr 1fr 1.15fr; gap: 5mm; }
  .pf-optcol > .pf-cap {
    display: block; margin-bottom: 1.2mm; padding-bottom: 0.8mm;
    border-bottom: 0.22mm solid var(--rule-soft);
    font-size: 5.9pt; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--label);
  }
  /* ═══ Interface-side diagram ══════════════════════════════════════════ */
  .pf-uiblock {
    display: grid; grid-template-columns: auto auto;
    justify-content: start; gap: 5mm; align-items: center;
  }

  /* ── from the easyloader mockup ─────────────────────────────────────────── */
  /* Contact data is never abbreviated: an ellipsised email is a wrong email. */
  .pf-fld > .pf-vl.pf-full {
    white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere;
  }
  /* Several ruled lines under one label — address blocks. */
  .pf-lines { display: block; }
  /* Checkmark: two borders on a rotated box, optically centred. A glyph would
     depend on a font the PDF renderer may not have. */
  .pf-tick .pf-bx::after {
    content: ""; width: 1.05mm; height: 2.0mm;
    border: solid #fff; border-width: 0 0.4mm 0.4mm 0;
    transform: translateY(-0.28mm) rotate(43deg);
    visibility: hidden;
  }
  /* ═══ Interface-side diagram ═════════════════════════════════════════ */
  .pf-uiblock {
    display: grid; grid-template-columns: auto auto;
    justify-content: start; gap: 5mm; align-items: center;
  }
  .pf-inlinefld .pf-run.pf-short { min-width: 9mm; }
  /* ═══ Table sections ══════════════════════════════════════════════════ */
  .pf-sectbl { display: grid; gap: 0; }
  .pf-sectbl .pf-hdr,
  .pf-sectbl .pf-rw {
    display: grid;
    grid-template-columns: 22mm 26mm 1fr 44mm;
    align-items: center;
    gap: 3mm;
    padding: 1.1mm 2mm;
  }
  .pf-sectbl .pf-hdr {
    padding-top: 0; padding-bottom: 1mm;
    font-size: 5.9pt; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--label);
  }
  .pf-sectbl .pf-rw { border-top: 0.22mm solid var(--rule-soft); }
  .pf-sectbl .pf-rw.pf-empty { color: var(--label); }
  .pf-sectbl .pf-rw .pf-name { font-weight: 700; font-size: 8.2pt; }
  .pf-sectbl .pf-note { font-size: 6.6pt; color: var(--label); }
  .pf-sectbl .pf-surf { display: flex; gap: 5mm; }
  .pf-sectbl .pf-total {
    margin-top: 1.4mm; padding: 1.1mm 2mm;
    background: var(--tint); border-radius: 0.8mm;
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 7.6pt;
  }
  .pf-sectbl .pf-total b { font-size: 8.6pt; font-variant-numeric: tabular-nums; }
  /* ═══ Roll feed distances ═════════════════════════════════════════════ */
  .pf-rollfeed {
    margin: 1mm 0 0 calc(var(--bx) + 1.8mm + 2.5mm);
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 1.5mm 5mm;
  }
  .pf-rollfeed .pf-cap { font-size: 6.6pt; color: var(--label); text-transform: uppercase; letter-spacing: 0.08em; }
  /* ═══ Blank-form mode ═════════════════════════════════════════════════ */
  .pf-sheet.pf-blank .pf-vl,
  .pf-sheet.pf-blank .pf-lines .pf-ln,
  .pf-sheet.pf-blank .pf-run,
  .pf-sheet.pf-blank .pf-sectbl .pf-rw .pf-val,
  .pf-sheet.pf-blank .pf-sectbl .pf-total b,
  .pf-sheet.pf-blank .pf-writein .pf-body { color: transparent; }

  /* ── from the fabricpro mockup ─────────────────────────────────────────── */
  /* ═══ Handling instruction strip (printed on the FabricPro form only) ══ */
  .pf-handling {
    margin-top: 2.6mm;
    display: grid; grid-template-columns: auto 1fr; gap: 3mm;
    align-items: baseline;
    padding: 1.4mm 2.4mm;
    border: 0.22mm solid var(--rule);
    border-left: 0.7mm solid var(--alarm);
    border-radius: 0.8mm;
    background: #fdf7f7;
    font-size: 7pt;
  }
  .pf-handling .pf-tag {
    font-size: 5.9pt; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--alarm); white-space: nowrap;
  }
  .pf-handling em { font-style: normal; font-weight: 700; color: var(--alarm); }
  /* An option whose value is a measured length, ruled off to the right. */
  .pf-optrow {
    display: grid; grid-template-columns: 1fr auto;
    align-items: center; gap: 4mm;
    padding: 0.85mm 2.5mm; border-radius: 0.7mm;
  }
  .pf-optrow.pf-on { background: var(--tint-hit); }
  /* ═══ Illustration beside the machine-choice block ════════════════════ */
  .pf-figblock { display: grid; grid-template-columns: 1fr auto; gap: 5mm; align-items: center; }
  .pf-figblock img {
    display: block; height: 30mm; width: auto; max-width: 100%;
    border: 0.22mm solid var(--rule); border-radius: 0.8mm;
  }
  .pf-uiblock {
    display: grid; grid-template-columns: auto auto;
    justify-content: start; gap: 5mm; align-items: center;
  }
  /* ═══ Freight disclaimer ══════════════════════════════════════════════ */
  .pf-terms {
    margin-top: 1.2mm; padding-left: calc(var(--bx) + 1.8mm + 2.5mm);
    font-size: 6.6pt; line-height: 1.35; color: var(--ink-soft);
  }
  .pf-officegrid .pf-span2 { grid-column: span 2; }
  /* ═══ Blank-form mode ═════════════════════════════════════════════════ */
  .pf-sheet.pf-blank .pf-vl,
  .pf-sheet.pf-blank .pf-lines .pf-ln,
  .pf-sheet.pf-blank .pf-run { color: transparent; }
  .pf-sheet.pf-blank .pf-opts > .pf-tick.pf-on,
  .pf-sheet.pf-blank .pf-optrow.pf-on { background: transparent; }

  /* ── from the l-series mockup ─────────────────────────────────────────── */
  /* Fitted as standard, not chosen. */
  .pf-tick.pf-std .pf-bx { background: var(--box-line); border-color: var(--box-line); }
  /* A quantity box: the printed form says to replace the X with a number
     when more than one is required, so one box carries both states —
     a mark for 1, the figure itself for 2 or more. */
  .pf-tick .pf-q {
    display: none;
    color: #fff; font-weight: 700; font-size: 7.4pt; line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .pf-tick.pf-qty .pf-bx { background: var(--navy); border-color: var(--navy); }
  .pf-tick.pf-qty .pf-bx::after { visibility: hidden; }
  .pf-tick.pf-qty .pf-q { display: block; }
  .pf-tick.pf-qty .pf-tx { font-weight: 700; }
  .pf-opts > .pf-tick.pf-on, .pf-opts > .pf-tick.pf-qty { background: var(--tint-hit); }
  .pf-opts.pf-stacked > .pf-tick { align-items: start; }
  /* ═══ Write-in block ══════════════════════════════════════════════════ */
  .pf-writein {
    border: 0.22mm solid var(--rule); border-radius: 1mm;
    padding: 1.6mm 2.2mm 1.8mm; min-height: 12mm;
  }
  /* ═══ Reference notes at the foot of the sheet ════════════════════════ */
  .pf-notes {
    margin-top: 2.6mm; padding-top: 1.6mm;
    border-top: 0.22mm solid var(--rule);
    display: grid; grid-template-columns: 1.15fr 1fr; gap: 6mm;
    font-size: 6.2pt; line-height: 1.4; color: var(--ink-soft);
  }
  .pf-notes .pf-cap {
    display: block; margin-bottom: 0.8mm;
    font-size: 5.7pt; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--label);
  }
  .pf-notes ul { margin: 0; padding-left: 3mm; }
  .pf-notes li { margin-bottom: 0.4mm; }
  .pf-notes .pf-num { font-variant-numeric: tabular-nums; }
  .pf-footnote {
    margin-top: 2mm; padding-top: 1.2mm;
    border-top: 0.22mm solid var(--rule-soft);
    display: flex; justify-content: flex-end;
    font-size: 6.2pt; color: var(--label);
  }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-bx,
  .pf-sheet.pf-blank .pf-tick.pf-qty .pf-bx { background: #fff; border-color: var(--box-line); }
  .pf-sheet.pf-blank .pf-tick.pf-qty .pf-q { display: none; }
  .pf-sheet.pf-blank .pf-opts > .pf-tick.pf-on,
  .pf-sheet.pf-blank .pf-opts > .pf-tick.pf-qty { background: transparent; }
  .pf-sheet.pf-blank .pf-tick.pf-on .pf-tx, .pf-sheet.pf-blank .pf-tick.pf-qty .pf-tx { font-weight: 400; }

  /* ── L-Series fits one A4 only when it is a little denser ──────────────
     It carries more than any other sheet: a tools grid, an options grid, a
     PathWorks row, notes, AND the two reference blocks the paper form prints
     at its foot. The mockup overflows A4 by ~90px for the same reason.
     Rather than drop a block the workshop reads, the sheet tightens: the
     dense grids keep their type size and lose a little air.
     Measured, not guessed -- see scripts/preview-form-html.ts and the
     Playwright measurement described in the order-form-components memory. */
  .pf-sheet.pf-dense .pf-sec { margin-top: 2.4mm; }
  .pf-sheet.pf-dense .pf-sec > h2 { margin-bottom: 1.4mm; padding-top: 0.7mm; padding-bottom: 0.7mm; }
  .pf-sheet.pf-dense .pf-opts > .pf-tick { padding-top: 0.6mm; padding-bottom: 0.6mm; }
  .pf-sheet.pf-dense .pf-office { margin-top: 2.6mm; padding: 1.6mm 2.8mm 2.2mm; }
  .pf-sheet.pf-dense .pf-officegrid { gap: 2mm 6mm; }
  .pf-sheet.pf-dense .pf-writein { min-height: 9mm; padding: 1.2mm 2.2mm 1.4mm; }
  .pf-sheet.pf-dense .pf-notes { margin-top: 2mm; padding-top: 1.2mm; }
  .pf-sheet.pf-dense .pf-notes li { margin-bottom: 0.2mm; line-height: 1.25; }
  .pf-sheet.pf-dense .pf-metastrip { margin-top: 2.2mm; }
  .pf-sheet.pf-dense .pf-secrow { margin-top: 2.4mm !important; }
  .pf-sheet.pf-dense .pf-footnote { margin-top: 1.6mm; padding-top: 1mm; }

  /* ═══ 2026-09-16 layout pass ═════════════════════════════════════════ */
  /* Selected ticks sitting side by side in the options grid read as one
     band without a gap between them, so the grid gets a column gap. */
  .pf-opts:not(.pf-row):not(.pf-col):not(.pf-one) { column-gap: 1.2mm; }
  .pf-opts.pf-four { row-gap: 0.6mm; }
  /* A labelled line under a grid -- the M-Series power row. */
  .pf-subrow {
    display: flex; align-items: center; gap: 3mm;
    margin-top: 1.2mm; padding-top: 1mm;
    border-top: 0.22mm solid var(--rule-soft);
  }
  .pf-subrow > .pf-lb { flex: none; padding-left: 2.5mm; }
  .pf-subrow > .pf-opts.pf-row { gap: 0.6mm 1.2mm; }
  /* End user: three compact rows instead of two stacked columns. */
  .pf-eu {
    display: grid;
    grid-template-columns: 1fr 1fr 0.85fr 1.35fr;
    gap: 1.6mm 4mm;
  }
  .pf-eu .pf-s2 { grid-column: span 2; }
  .pf-eu .pf-s3 { grid-column: span 3; }
  /* Side diagram: level with the label, right beside the ticks. */
  .pf-sideblock { gap: 4mm; }

  /* ═══ Option cells: box and text only ═══════════════════════════════ */
  /* No rules, outlines or edge strokes on an option cell (Vadym,
     2026-09-17): an unticked option is a box and its text on plain paper;
     a ticked one gets the tint band and the tick, nothing else. */
  .pf-opts > .pf-tick { box-shadow: none; border: 0; }

  /* ═══ Print ═══════════════════════════════════════════════════════════ */
  /* One sheet per form, each starting a new page. \`break-after\` on the last
     sheet would emit a trailing blank page, so it is set on every sheet but
     the last one. */
  @page { size: A4 portrait; margin: 0; }
  .pf-sheet + .pf-sheet { break-before: page; }
  body { margin: 0; background: #fff; }
`;
