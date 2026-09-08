# Quote copy for the five empty categories

Draft copy for the five catalog categories that currently print nothing under a
product's heading on a quotation. Task 12 of
`docs/superpowers/plans/2026-09-07-category-quote-copy.md`.

Two further categories have since been added below and are labelled as such:
`EL`, whose copy existed but was broken, and `FPT`, a series split out of `FP`
after this file was written.

**How to use this file.** For each category below, copy the HTML block and paste
it into that category's **Quote description** card at
`/catalog/<series id>` (admin only). The copy is authored once per category and
is printed under the heading of *every* product in it, with each product's own
figures substituted into the `{{token}}` placeholders. Then open a draft quote
containing a product from that category and confirm it reads correctly with real
figures and no stripped-token banner.

**Sources.** Product facts come from the Pathfinder Brain
(`02 Products/L-Series.md`, `Leather Nesting System.md`,
`EasyLoader & EasyFeeder.md`, `Roll Feeding.md`) and from the product
descriptions already in `prisma/seed-data/catalog.json`, which are the May 2026
Australian price list. Register and structure are matched to the one approved
body, the old `machine.m-series` content block (now `Series.quoteDescription`
for M and X). Nothing here is asserted that a Pathfinder source does not state.

---

## Two decisions that apply to every category below

**No `{{price}}` or `{{basePrice}}` anywhere.** The M-Series body ends with
`**Price: {{price}}**`, but that line predates the sheet's structural section
price. `buildQuotationData` now exposes `sectionPrice` separately and
`equipment-detail.tsx` prints `Price: …` under every section heading unless the
copy contains a literal `{{price}}` (`hasInlinePrice`). So an inline price token
adds nothing: the sheet already prints the price for every section, with or
without one. That is the whole reason to leave it out.

It is not a safety measure. `substituteWithReport` used to strip by `\n`-
delimited line, and Tiptap saves a body as a single line with no newlines
between block elements, so an `OMIT`-ed `{{price}}` on a prices-hidden quote
really did delete the entire description. Commit `0590ecb` made the strip
per block element (`htmlBlockLines`), so today only the price line itself goes.
The conclusion stands; the danger it was once also justified by does not.

**Every token used here resolves for every product in its category.** Nothing
below can strip a line or raise the draft banner. Checked against
`prisma/seed-data/catalog.json`.

---

## L-Series (`L`)

```html
<p>Model {{model}} conveyorised computer controlled cutting system for single-ply and low-ply work. Maximum cutting width {{cutWidthCm}}cm.</p>
<ul>
<li>Conveyorised cutting belt — perforated urethane, or porous felt on F models</li>
<li>Two-speed vacuum material hold-down</li>
<li>Offloading conveyor</li>
<li>Multi-tooled cutting head — facility for three tool holders fitted simultaneously, plus laser spot and marking tool</li>
<li>MRK (Marking Tool) included as standard</li>
<li>Embedded machine controller — X-axis, Y-axis, knife rotation and general I/O</li>
<li>Safety system</li>
<li>Standard roll feeding device</li>
</ul>
<h3>Software</h3>
<ul>
<li>PathCut™ cutter operating software</li>
</ul>
<p><em>Quick release tools are not included. The standard roll feeding device included may not be suitable for all materials.</em></p>
```

**Tokens used**

- `{{model}}` — the product code. Universal; every product carries one.
- `{{cutWidthCm}}` — all eight L-Series products carry `specs.cutWidthCm`
  (180, 226, 320). Offered because at least one product has it, and safe to use
  because *every* one does.

**Deliberately not used:** `{{cutHeightCm}}` — no L-Series product carries a lay
height, so the token is not on the category's palette and the copy never
mentions compressed lay height. `{{specSentence}}` is available (all eight are
`kind: "MACHINE"`) but would only restate the heading.

**Unsure:** the brochure contradicts itself on simultaneous tools — body copy
says four, the spec table says three tool holders plus laser spot and marking
tool, and the price list agrees with the spec table. The Brain says do not
publish "four" until engineering confirms, so this copy says three.

---

## Leather Nesting System (`LNS`)

```html
<p>Model {{model}} Leather Nesting System — an offline hide digitising and nesting workstation. Hides are photographed and nested while the cutting machine keeps cutting, and the completed nest is sent to the cutter.</p>
<ul>
<li>Operator console with utility drawer, including mounting bracket for the Pathfinder EasyLoader side frame</li>
<li>Windows computer, keyboard, mouse and Microsoft Surface Dial</li>
<li>Digital SLR camera and adjustable camera stand</li>
</ul>
<h3>Software</h3>
<ul>
<li>PathWorks™ (standalone) CAD software</li>
<li>ANT — Automatic Nesting licence, optioned within PathWorks™</li>
<li>WHD — Leather Hide Wizard</li>
</ul>
<h3>Capability</h3>
<ul>
<li>Digitisation of hide perimeters, and identification and marking of quality zones within the hide</li>
<li>Multi-hide nesting — nesting simultaneously across several hides</li>
<li>Automatic hide position registration, with image editing tools</li>
<li>Full operator control over piece placement: manual placement, automatic nesting, or a combination of both</li>
<li>Barcode identification of the correct digital file for cutting</li>
</ul>
<p><em>Compatible with Pathfinder M-Series and L-Series cutting machines.</em></p>
```

**Tokens used**

- `{{model}}` — the product code. The only spec-free token this category can
  fill: all three LNS products have `specs: null`, so the palette offers exactly
  `model`, `name`, `price` and `basePrice`, and nothing else.

**Deliberately not used:** `{{specSentence}}` is unavailable — no LNS product is
`kind: "MACHINE"` (they are `SYSTEM`).

**Left out on purpose:** any dimension or yield figure. The brochure publishes no
hide-yield percentage, and its `R` dimension (3045–4225 mm, probably overhead
clearance) is undefined in the source — the Brain says do not put it in a
customer document until engineering confirms it.

**Unsure:** the Brain records that the brochure's narrow model is **LNS-2040**
(2040 mm wide) and that the price list's `LNS-2020` is a transcription error.
The catalog still carries `LNS-2020`, so `{{model}}` will print the code the
catalog holds. That is a catalog data question, not a copy question, but a
customer quote is where the wrong code becomes visible. The brochure also calls
the product "Leather Nesting **Station**"; this copy uses "System" to match the
category name and product names already in the catalog.

---

## EasyFeeder (`EF`)

```html
<p>Model {{model}} EasyFeeder™ roll feeding system, {{tableWidthMm}}mm width. Delivers a single layer of rolled material into the Pathfinder cutting system tension-free and edge-aligned, synchronised with the cutter.</p>
<ul>
<li>Full synchronisation with the Pathfinder cutting machine — M-Series and L-Series</li>
<li>Electronic edge control — sensors detect the material edge and make lateral adjustments; automatic or manual</li>
<li>Automatic and manual feed modes; forward, reverse, and material rewind at the press of a button</li>
<li>Additional bar feed location, for next job preparation or for delivering vacuum overlay plastic</li>
<li>Supports both bar-fed and bar-less (cradle) roll feeding</li>
<li>Loading at normal table height, adjustable 845–905mm — no bending, no lifting rolls above a cradle, and no bar through the roll core</li>
<li>ON/OFF switch and safety stop switch</li>
<li>Modular construction</li>
<li>Roll keeper and plastic roll holder included</li>
</ul>
<p><em>EasyFeeders are exclusively available with Pathfinder cutting systems.</em></p>
```

**Tokens used**

- `{{model}}` — the product code.
- `{{tableWidthMm}}` — all four EF products carry `specs.tableWidthMm` (2020,
  2420, 3220, 4030). This is the EasyLoader/EasyFeeder token, not
  `{{paperWidthMm}}`, which belongs to Punchline and which no EF product carries.

**Deliberately not used:** `{{cutWidthCm}}` / `{{cutHeightCm}}` — no EF product
carries either, so neither is on the palette. `{{specSentence}}` is unavailable:
EF products are `kind: "FEEDER"`, not `MACHINE`.

**Left out on purpose:** conveying speed, maximum roll weight, roll diameter and
core diameter. The EasyFeeder brochure publishes none of them; the Brain lists
all four as still unknown. A customer needing those figures is being quoted a
Heavy Duty Roll Feeder.

**Unsure:** the catalog carries `EF-4030`, and the Brain records that the Aug
2026 brochure's widest model is **EF-4120** (4120 mm) with no `4030` anywhere —
so `{{tableWidthMm}}` will print `4030` on that one product. Again a catalog
data question, but it prints on a signed quote. The Brain also lists `EF-3220`
as a real model absent from the Australian price list.

---

## Heavy Duty Roll Feeder (`HDRF`)

```html
<p>Model {{model}} Heavy Duty Roll Feeder — a free-standing braked roll holder for heavy and large-diameter rolls, compatible with all Pathfinder automatic cutting machines.</p>
<ul>
<li>Roll diameter up to 900mm</li>
<li>Adjustable core support for 70–80mm cores; an increase to 200mm is available on special request</li>
<li>Adjustable disk brake with variable resistance, preventing roll run-away</li>
<li>Guide rollers</li>
<li>Heavy-duty lockable castors</li>
<li>1540mm high, 875mm deep</li>
</ul>
<p><em>Maximum roll weight and maximum roll width vary by model. See the specification for the model quoted.</em></p>
```

**Tokens used**

- `{{model}}` — the product code. The only usable token: all three HDRF products
  have `specs: null`, so the palette is `model`, `name`, `price`, `basePrice`
  only. `{{specSentence}}` is unavailable (`kind: "ACCESSORY"`).

**Left out on purpose — this is the important one.** The catalog description on
all three products says "rolls up to 500kg", and the brochure headline says
"engineered to handle up to 500kg". Per the Brain, **500 kg is the HDRF-180
figure only**: capacity falls to 350 kg (HDRF-220) and 250 kg (HDRF-320). One
shared paragraph cannot print a per-model figure — there is no weight token —
so printing "500kg" under an HDRF-320 heading would overstate its rating by
100%. The copy states that the figure varies by model instead. **Roll width is
also omitted:** the brochure body says 2240 mm, its own spec table says 2260 mm,
and the website says 2000 mm; the Brain says do not print a roll-width number
until engineering settles it.

**Unsure:** if a weight figure must appear on the quote, the cleanest fix is a
`rollWeightKg` spec on each HDRF product plus a token for it — a change to
`quote-variables.ts` and the catalog, out of scope for this task.

---

## Service (`SVC`)

```html
<p>This item is a service, support or trade-in line rather than equipment, and is supplied on the terms and conditions of sale set out in this quotation.</p>
<p>Where the item quoted is a Remote Support Program, its inclusions, discounts, payment, renewal and cancellation terms are those set out in the Pathfinder Remote Support Program section of this quotation.</p>
```

**Tokens used**

- **None.** All four SVC products (`RSP`, `RSP+`, `SERVICE`, `TRADE-IN`) have
  `specs: null`, so the palette offers only `model`, `name`, `price` and
  `basePrice`. `{{model}}` was dropped because "Model TRADE-IN" reads badly, and
  the price prints structurally without a token.

**Unsure — read this one before pasting it.** This is the weakest of the five,
and the reason is structural rather than editorial. The Brain has no service or
support note at all: `Software Overview.md` and `PathWorks.md` cover PathWorks,
PathCut and Production Analyst and say nothing about the Remote Support Program.
The only authoritative RSP text in the project is the `rsp.agreement` content
block, which already prints as its own section on the quote — repeating it here
would duplicate it under the item heading.

More importantly, `SVC` holds four items with nothing in common: a support
subscription, that subscription plus an annual preventative-maintenance visit, a
bag of installation and training services, and a **credit** for a machine the
customer is disposing of. Any paragraph true of all four is necessarily vague,
and the one above is deliberately vague rather than wrong. Two better options,
both needing a decision from you:

1. Split `SVC` into separate categories (support, services, credits) and write
   real copy for each. This is what the shared-copy-per-category model is asking
   for.
2. Leave `SVC.quoteDescription` empty. The section heading still prints the
   item's name and the price, which for a trade-in credit is arguably all a
   customer needs under the heading.

---

## EasyLoader (`EL`)

`EL` is not one of the five empty categories — it is the one category whose
copy already existed and was *broken*. The `equipment.easy-loader` block opened
`Conveyorised Spreading Table ({{lengthM}}mtr)`, and `{{lengthM}}` was a
per-option-line attribute variable whose mechanism has been deleted: the line
stripped on every quote, and the category could not be re-saved from the editor
at all, because `updateSeriesQuoteDescription` rejects a token the category
cannot fill.

`{{tableLengthM}}` replaces it. **You do not need to paste this one by hand:**
`scripts/migrate-content-blocks-to-series.ts` performs the rewrite as it moves
the block onto the category, and says so in its dry run
(`[REWRITE] equipment.easy-loader: {{lengthM}} -> {{tableLengthM}}`). The body
below is what that produces, recorded here so the category reads like the
others in this file and so a hand-edit has something to compare against.

```html
<p>Conveyorised Spreading Table ({{tableLengthM}})</p>
<p>The Easy-Loader is designed to integrate with the Pathfinder cutting system, automatically presenting spread materials into the cutting machine.</p>
<ul>
<li>{{tableWidthMm}} table width</li>
<li>Modular design</li>
<li>Digitally controlled speed drive</li>
<li>Manual/Auto bypass switch</li>
<li>Auto synchronised with Pathfinder cutter</li>
</ul>
```

**Tokens used**

- `{{tableLengthM}}` — the total table length, **computed from the item's own
  option lines**, not read off the product. An EasyLoader is built from 1.2 m
  modules (`SECTION_UNIT_M`), each sold as an option carrying
  `Option.unitLengthM`, so this sums `unitLengthM × qty` over the item's
  `EL_DRIVE`, `EL_CONVEYOR` and `EL_STATIC` lines and formats the result with
  `formatMetres` — `4.8 m`, `6 m`, trailing zeros dropped. `EL_BUSBAR` and
  `EL_RAIL` are excluded: one of each is added per module for the table's whole
  length, so counting them would roughly triple the figure.
- `{{tableWidthMm}}` — all four EL products carry `specs.tableWidthMm`.

**Note the missing unit.** The old copy wrote `({{lengthM}}mtr)` because the old
token substituted a bare number. `formatMetres` carries its own unit, so the
migration drops that trailing `mtr` — otherwise the quote would read
`(4.8 mmtr)`. If you paste this body by hand, do not add the unit back.

**The one case where this line still strips.** An EasyLoader item with no table
modules configured has no length, so `{{tableLengthM}}` resolves to `""` and its
line goes, reported in the draft banner. That is correct: the category offers
the token because its products *can* carry a layout, and this particular item
has none yet. Configure the layout and the line returns.

---

## Fabric Pro Trolley (`FPT`)

`FPT` is not one of the original five empty categories above — it is a new
series split out of `FP` (see `docs/superpowers/plans/2026-09-07-category-quote-copy.md`'s
sibling task moving `FP-TROLLEY` out of the FabricPro spreaders). It gets the
same treatment as the others: no `Series.quoteDescription` exists for it yet,
so copy is drafted here ready to paste once the series exists.

```html
<p>Model {{model}} Fabric Roll Trolley, purpose-built to work with the FabricPro™ spreading system. Rolls slide directly into the FabricPro loading cradle, eliminating the need for a separate bulky roll-lifting device.</p>
<ul>
<li>Carries up to 2 fabric rolls</li>
<li>2 lockable castor wheels</li>
<li>Welded steel construction</li>
<li>Compatible with EasyLoader tables (880–940mm height)</li>
<li>Compact flat-packed design</li>
</ul>
<p><em>Sold as a companion product alongside FabricPro, not an integrated option.</em></p>
```

**Tokens used**

- `{{model}}` — the product code. The only usable token: `FP-TROLLEY` is
  currently the sole `FPT` product and has `specs: null`, so the palette is
  `model`, `name`, `price`, `basePrice` only — same shape as `HDRF` and `SVC`
  above. `{{specSentence}}` is unavailable (`kind: "ACCESSORY"`). Per the two
  decisions above, `{{price}}`/`{{basePrice}}` are left out (the section price
  prints structurally regardless). `{{name}}` is left out for style, not
  safety — it resolves correctly (see the closing note), but this body's
  opening line already names the product through `{{model}}`.

**Left out on purpose.** The Pathfinder Brain's Roll Trolley note
(`02 Products/Roll Feeding.md`, sourced from the Jul 2025 brochure) says the
brochure publishes **no maximum load per roll or total, no overall
dimensions, and no mass for the trolley itself** — "the most commercially
important missing number" in the whole material-handling range (also tracked
as Brain Open Question 20). None of that appears above. The brochure's
"Height-adjustable platform (range: 60mm)" spec is also left out: it is 60mm
of *travel*, not an absolute height, and the vault flags it as easy to
misread as a table-height figure — the catalog description's own
"EasyLoader tables (880–940mm height)" line already gives the useful absolute
range, sourced from the website rather than the brochure, and that is what
this copy keeps.

**Unsure.** The Pathfinder Brain (`02 Products/Product Portfolio MOC.md`)
records the Roll Trolley as **not currently on the Australian price list** —
consistent with `FP-TROLLEY`'s `AU: 0.0` in `docs/reference/catalog-v2-target.json`,
which the seed turns into `price: null, needsReview: true`. That is a pricing
data question, not a copy one, but it means this body will print under a
section whose structural price line is currently blank until AU pricing is
set. This copy is otherwise based only on `FP-TROLLEY`'s own catalog
description plus the brochure/website facts above — it has not been reviewed
by anyone at Pathfinder the way the M-Series body (the one approved
precedent) was.

---

## One bug found while checking tokens — since fixed

`{{name}}` was offered by `categoryTokensFor` in `src/lib/quote-variables.ts`
but **was not in the `vars` object** `buildQuotationData` substitutes against,
so it passed validation on save and then stripped its own line on every quote.
Commit `231eef2` fixed it: `vars` is now typed `Record<CategoryTokenName, …>`,
so a name in `CATEGORY_TOKEN_NAMES` with no value beside it in
`quotation-data.ts` fails to compile, and `tests/quotation-data.test.ts`'s
"fills every token the registry offers" holds the two lists together. **`{{name}}`
works — it resolves to the item's own name, the same string the section heading
prints.** None of the copy above happens to use it, which is a matter of taste
rather than of safety.
