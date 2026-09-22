# Quote Builder Redesign — Design

Date: 2026-09-22
Status: Pending approval
Branch: `redesign/quote-builder-ux`
Mockups: `docs/redesign/builder-mockup.html` (v1, concept), `docs/redesign/builder-mockup-v2.html` (v2, approved shape)

## Problem

`/quotes/[documentId]` is the screen a salesperson spends their working day in,
and it is the screen that has absorbed the most features without ever being
re-composed. An audit of the live app at `localhost:3100` against the real
`Q-AU-2026-010` quote found the following, in order of how much they cost the
person assembling a quote.

**The work is buried in configuration.** The left column stacks eleven
`SectionCard`s in one flow. "Items" sits in the same visual register as "Setup
image", "Quotation pricing display" and "Email history". Three of those cards
change on every quote; seven are set once and never touched again; two are
read-only history. They all look identical and they are interleaved.

**Machines are hard to tell apart.** Every item is a `rounded-xl border` card
nested inside the Items `SectionCard`, separated by `gap-3`. Each one opens two
drawers, "Production spec" and "Options", whose trigger buttons share a
byte-identical class string, so the two are distinguished only by their label.
The options drawer is an inline pseudo-modal (`max-h-[70dvh]`, own scroll
region, sticky footer) rendered four levels deep: page card → item card →
accordion body → drawer. With three machines open the page runs several
viewports long and the boundary between one machine and the next disappears.

**Readiness is a surprise.** `FinalizeButton` reports its blockers only after
the user presses it. Nothing on the page says which machine is missing a
production spec until the attempt fails.

**The total disappears where it matters.** Status and actions are rendered
twice in the DOM (`page.tsx:421-455` under `hidden lg:block`, `page.tsx:464-478`
under `lg:hidden`), and the Summary card with the totals exists only in the
first. Between 768px and 1023px the user gets the single-column layout, the
desktop icon rail, and no total at all.

**Editing a price needs a mouse.** `EditablePrice`'s pencil is
`opacity-0 group-hover:opacity-100` (`item-breakdown-editor.tsx:413`). On a
tablet or phone there is no hover, so the affordance does not exist.

**The token system has drifted.** On this one screen: five radii
(`rounded-lg` ×35, `rounded-xl` ×10, `rounded-full` ×9, `rounded-md` ×7, bare
`rounded` ×2), six control heights, nine wrapper treatments, six parallel badge
implementations, four field layouts, three checkbox sizes, two divider colours
and two input border colours. `Button`'s largest CVA size is `h-9` (36px)
against the app's own 44px touch rule, so every builder call site overrides it
with `className="h-11"`, and there is no `brand` variant, so
`bg-brand text-white hover:bg-brand/90` is written by hand four times. Geist is
loaded through `next/font` and then overridden in `globals.css:154-157`, so the
app actually renders in Segoe UI.

**Accessibility gaps.** The item accordion toggle is a `<div onClick>` with no
`role`, `tabIndex` or key handler (`items-list.tsx:311`); it is operable by
keyboard only because a nested button's click bubbles. None of the three
`aria-expanded` triggers has `aria-controls`. There is no `<h3>` anywhere in
the builder, so the whole Items list is one flat `<h2>` region. Drag-to-reorder
has no keyboard path, and the arrow buttons that substitute for it are
`hidden … md:flex`, so on a phone a keyboard user cannot reorder at all.
`noCommission` is signalled by a background wash with no text equivalent.

## Skills applied

`taste-skill` (github.com/Leonxlnx/taste-skill) states in section 13 that it is
not for dashboards, dense product UI, data tables or multi-step forms, and asks
that this be said explicitly. The builder is all four. The primary ruleset is
therefore `redesign-skill` from the same repository, which is written for
existing applications. From `taste-skill` this design takes only the
cross-cutting sections: 9 (AI tells), 11 (redesign protocol), 14 (pre-flight).
`ui-ux-pro-max` (vendored at `.claude/skills/ui-ux-pro-max`) supplies the
touch, form and animation guidelines. `web-animation-design` supplies the
motion tokens.

Redesign mode is **Preserve** (section 11.C/11.F): brand palette, routes,
slugs, nav labels and form field names are fixed.

## Decisions

| # | Decision |
|---|---|
| D1 | The builder splits into three tabs: **Build** (client, machines, extra lines), **Quote terms** (discount, delivery, validity, notes, documents, setup image, pricing display), **History** (revisions, emails, production forms). |
| D2 | Tab state lives in the URL as `?tab=terms` / `?tab=history`. Absent or unknown values fall back to Build. The route itself does not change. |
| D3 | A sticky **quote bar** carries back link, company, quote number, save state, status badge, grand total and the primary action, at every breakpoint. The duplicated desktop/mobile status blocks are deleted. |
| D4 | The right rail gains a **readiness panel**: one row per finalize precondition, each unmet row linking to the thing that is missing. `FinalizeButton` keeps its own server-side guard; the panel is an additional, earlier signal, derived from the same predicate. |
| D5 | Each machine becomes its **own card** at the page level with a 16px gap. The Items `SectionCard` wrapper is removed and replaced by a lightweight section header. One level of nesting disappears. |
| D6 | Inside an expanded machine, the two drawers collapse into **one sub-tab strip: Options / Spec / Price**. One panel is visible at a time. |
| D7 | Sub-tabs contain only what their label names. **Global per-item actions live in a row below the sub-tabs**: discount inline on the left, a `…` menu on the right holding "Show image in PDF", "Duplicate machine" and "Delete machine". |
| D8 | Option selection moves out of the inline pseudo-modal into a **side sheet** (full-screen below `sm`) built on Base UI `Dialog`, giving it the focus trap, Escape handling and scroll lock it currently lacks. |
| D9 | The **collapse control is one button** that toggles between "Collapse all" and "Expand all" with a flipping chevron icon, replacing the two text buttons separated by a literal `|`. |
| D10 | On load, all machines are collapsed **except** those failing a readiness check. Expansion state is not persisted between visits. |
| D11 | The price pencil becomes **always visible** at 38% opacity inside a button-shaped target, so the affordance exists without hover. |
| D12 | Motion is **feedback only**. Nothing animates on page load, nothing loops, nothing moves without a user action. Tokens in section "Motion" below. No new dependency: CSS only. |
| D13 | Token consolidation is a **prerequisite step**, landed and verified before any structural change, so that the structural diff is about structure. |
| D14 | Icons stay `lucide-react`. `redesign-skill` discourages it as the AI default, but it is the repo's single icon source and swapping it would churn a 900-line spec editor for no user benefit. Recorded as a deliberate deviation. |
| D15 | Dark mode stays dead for now. The `.dark` token block in `globals.css:116-148` is never activated; this design neither removes nor enables it. Out of scope, flagged for a later decision. |

## Motion

Duration and easing tokens go into `globals.css` under `@theme inline` and are
used everywhere; no component invents its own timing.

```css
--t-micro: 120ms;    /* press feedback */
--t-ui: 180ms;       /* disclosure, tab swap */
--t-overlay: 220ms;  /* sheet, dialog */
--e-out: cubic-bezier(.215,.61,.355,1);    /* entering / exiting */
--e-move: cubic-bezier(.645,.045,.355,1);  /* on-screen movement */
```

| Interaction | Token | Easing | Why it earns its place |
|---|---|---|---|
| Any button `:active` | `--t-micro` | `--e-out` | `scale(.97)` confirms the tap landed |
| Machine expand / collapse | `--t-ui` | `--e-move` | Shows where the content came from |
| Sub-tab swap | `--t-ui` fade | `--e-out` | Replaces content without a jump |
| Options side sheet + scrim | `--t-overlay` | `--e-out` | Paired elements, identical timing |
| `…` menu | `--t-micro` | `--e-out` | Opens from `scale(.97)`, never from zero |
| Option chip added | `--t-ui` | `--e-out` | Confirms the option actually attached |
| Grand total changed | `--t-ui` | `--e-out` | Draws the eye to the figure that moved |
| Readiness meter | `--t-overlay` | `--e-move` | Shows the increment rather than blinking |

Every one of these is wrapped in `motion-reduce:` variants, and a global
`@media (prefers-reduced-motion: reduce)` block zeroes transitions and
animations. No springs, no load-time stagger, no infinite loops.

**One documented exception to "animate only transform and opacity".** The
machine disclosure uses the `grid-template-rows: 0fr → 1fr` technique, which is
a layout animation. It stays, because it is the only approach that handles
content of unknown height correctly. `opacity` and `translateY(-4px)` are
layered on top and carry the perceived motion, so the visible movement is
GPU-composited and the height change is merely mechanical.

## Token consolidation

Landed first, as its own commit, visually near-invisible.

| Today | After |
|---|---|
| 5 radii | `--r-control: 8px`, `--r-card: 12px`, `--r-pill` |
| 6 control heights | `--h-touch: 44px` (default, all touch), `--h-dense: 36px` (desktop-dense only) |
| 9 wrapper treatments | `SectionCard` (surface 1) + `.inset` (surface 2). Nesting depth picks the surface. |
| 6 badge implementations | `StatusBadge` (semantic state) + `Chip` (neutral fact) + `CountBadge` |
| 4 field layouts | one `FieldRow` with `layout="stacked" \| "inline"` |
| `border-slate-200` vs `-300` on inputs | one `--color-input-border` token |
| `border-slate-100` vs `-200` dividers | one `--color-divider` token |
| Button: max `h-9`, no brand variant | sizes reach 44px; `variant="brand"` added; all `className="h-11"` overrides deleted |
| Geist loaded, Segoe rendered | Geist enabled as `body` font; `tabular-nums` on every money figure |
| 8 bare "nothing here" sentences | `EmptyState` everywhere |
| 6 read-only shapes | one `ReadOnlyValue` primitive |
| 3 error channels, sometimes two at once | inline `role="alert"` under the control; toast reserved for optimistic-update rollback |

## Accessibility work

- Item header becomes a real `<button aria-expanded aria-controls>`; the panel
  gets a matching `id`.
- Machine name becomes `<h3>`, giving the Items region a document outline.
- `aria-controls` added to all three existing `aria-expanded` triggers.
- Drag handle gains a keyboard path: `Space` to pick up, `ArrowUp`/`ArrowDown`
  to move, `Space` or `Enter` to drop, `Escape` to cancel, with an
  `aria-live="polite"` announcement of each move. The arrow buttons lose
  `hidden … md:flex` and are available at every width.
- `noCommission` gains a text badge alongside the background wash.
- `htmlFor` coverage completed in `client-section.tsx`, `items-list.tsx`,
  `price-display-toggles.tsx` and `notes-section.tsx`.
- The options side sheet inherits focus trap, Escape and `aria-modal` from
  Base UI `Dialog` instead of hand-rolling none of them.

## Component boundaries

The redesign is also an opportunity to break up the three files that have grown
past the point where they can be reasoned about: `production-spec-editor.tsx`
(898 lines), `items-list.tsx` (646) and `item-options-editor.tsx` (646).

| New unit | Responsibility | Depends on |
|---|---|---|
| `builder/quote-bar.tsx` | Identity, status, save state, total, primary action | document summary props |
| `builder/builder-tabs.tsx` | Tab strip, URL sync, panel switching | `useSearchParams` |
| `builder/readiness-panel.tsx` | Renders precondition rows from a predicate | `lib/quote-readiness.ts` |
| `lib/quote-readiness.ts` | Pure function: document → list of `{ key, met, label, target }` | existing finalize guards |
| `builder/item-card.tsx` | One machine: header row, disclosure, sub-tab host | sub-panels below |
| `builder/item-panel-options.tsx` | Chips summary plus the button that opens the sheet | |
| `builder/item-panel-spec.tsx` | Production spec fields for one machine | split from `production-spec-editor` |
| `builder/item-panel-price.tsx` | Breakdown rows and editable prices | split from `item-breakdown-editor` |
| `builder/item-action-bar.tsx` | Discount plus the `…` menu | |
| `builder/options-sheet.tsx` | The side sheet: search, list, conflicts, footer | Base UI `Dialog` |
| `builder/use-item-reorder.ts` | Pointer drag plus the keyboard path, one hook | |

`lib/quote-readiness.ts` is the important one: it is a pure function, testable
without a DOM, and it is the single source both the readiness panel and
`FinalizeButton` read, so the two can never disagree about what "ready" means.

## Testing

- `lib/quote-readiness.ts` gets unit tests covering each precondition and the
  combinations that occur in the seed data, run under the existing `vitest`
  setup.
- The existing suite must stay green; `npm run typecheck`, `npm run lint` and
  `npm run test` run after every step.
- Visual verification happens against the running dev server on
  `localhost:3100` with the real `Q-AU-2026-010` and `Q-AU-2026-009` quotes, at
  375px, 768px, 1024px and 1440px, with before and after screenshots recorded
  per step.
- Keyboard verification: tab through an expanded machine, operate the
  disclosure, move an item with the keyboard, open and close the options sheet,
  confirm focus returns to the trigger.

## Out of scope

Routes and slugs. Nav labels. Form field names and order. Business logic,
pricing maths, role permissions. PDF rendering and production forms. The
signing screen at `/sign/[token]`. The catalogue, clients, documents and
settings screens, except where they consume a primitive changed in the token
step and must be checked for regression. Dark mode. Icon library.

## Risks

| Risk | Mitigation |
|---|---|
| Token step silently changes unrelated screens | It is its own commit; every screen is walked at two widths before the structural work starts |
| Moving seven cards into a Terms tab hides something a user relied on seeing | Readiness panel surfaces anything that blocks finalize; the tab strip shows all three tabs at all times |
| Splitting the 898-line spec editor breaks a form field name | Field names and order are preserved verbatim; the split is mechanical, and `npm run test` plus a manual save round-trip verify it |
| Keyboard reorder conflicts with the existing pointer drag | Both go through one `use-item-reorder` hook with a single state machine, rather than two parallel paths |
