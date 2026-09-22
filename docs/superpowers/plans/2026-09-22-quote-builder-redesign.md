# Quote Builder Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rebuild `/quotes/[documentId]` so assembling a quote is the whole screen, not one card among eleven, and collapse the token sprawl underneath it.

**Architecture:** Three sequential layers. First the design tokens and ui-kit primitives change with no structural edits, so the visual diff is near-zero and every screen can be regression-checked cheaply. Then a pure `lib/quote-readiness.ts` predicate lands with unit tests, because both the new readiness panel and the existing `FinalizeButton` must read one definition of "ready". Then the page restructures onto that foundation: quote bar, three URL-synced tabs, per-machine cards, sub-tabs, autosaving options sheet.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (CSS-first `@theme inline`, no config file), Base UI (`@base-ui/react`) for Dialog/Popover/Tooltip primitives, lucide-react icons, vitest (node environment, `tests/**/*.test.ts`), Prisma 7.

**Spec:** `docs/superpowers/specs/2026-09-22-quote-builder-redesign-design.md`

**Branch:** `redesign/quote-builder-ux` (already created from `main`)

---

## Before you start

Two commits by Vadym landed on this branch after it was cut: `6a073db`
(user-editor Role select) and `508e579` (action forms via `onSubmit`). They are
unrelated to this work. Do not revert or rebase them out.

Verification runs against the dev server the user already has up on
`http://localhost:3100`, signed in, with real quotes `Q-AU-2026-010`
(`/quotes/cmubyqmdr004cft9kg60mbmfp`, three machines, A$932,497.48) and
`Q-AU-2026-009`. `device_bash` cannot reach that port; use the Chrome browser
tools, which run in the user's own browser.

Git in this repo leaves stale `.git/index.lock` and `.git/HEAD.lock` files.
Delete them and retry rather than treating a lock as a concurrent process.

After every task: `npm run typecheck && npm run lint && npm run test`.

---

## File structure

### Created

| Path | Responsibility |
|---|---|
| `src/components/ui-kit/tooltip.tsx` | Base UI tooltip with a 500ms open delay. Replaces every native `title=` in the builder. |
| `src/components/ui-kit/chip.tsx` | `Chip` (neutral fact, e.g. an option name) and `CountBadge` (a number beside a label). |
| `src/components/ui-kit/read-only-value.tsx` | `ReadOnlyValue`: label plus value, the one shape a FINAL document renders a setting as. |
| `src/lib/quote-readiness.ts` | Pure: document summary in, ordered list of `ReadinessRow` out. No React, no Prisma client. |
| `tests/quote-readiness.test.ts` | Unit cover for every row and the combinations in seed data. |
| `src/components/builder/quote-bar.tsx` | Sticky identity/status/total/primary-action bar. |
| `src/components/builder/builder-tabs.tsx` | Tab strip plus `?tab=` URL sync. |
| `src/components/builder/readiness-panel.tsx` | Renders `ReadinessRow[]`; unmet rows link to their target. |
| `src/components/builder/item-card.tsx` | One machine: header button, disclosure, sub-tab host. |
| `src/components/builder/item-panel-options.tsx` | Chips summary plus the button that opens the sheet. |
| `src/components/builder/item-panel-spec.tsx` | Production-spec fields for one machine. |
| `src/components/builder/item-panel-price.tsx` | Breakdown rows and editable prices. |
| `src/components/builder/item-action-bar.tsx` | Discount plus three labelled icon buttons, one flat row. |
| `src/components/builder/options-sheet.tsx` | Autosaving side sheet. |
| `src/components/builder/use-item-reorder.ts` | Pointer drag plus keyboard reorder, one state machine. |

### Modified

| Path | Change |
|---|---|
| `src/app/globals.css` | Motion, shape, surface and divider tokens; Geist enabled; global reduced-motion block. |
| `src/app/layout.tsx` | No change needed (Geist variables already wired); verify only. |
| `src/components/ui/button.tsx` | 44px sizes, `brand` variant. |
| `src/components/ui-kit/field-row.tsx` | `layout?: "stacked" \| "inline"`; `fieldInputClass` reads the new tokens. |
| `src/components/ui-kit/section-card.tsx` | Radius and divider tokens; optional headerless "plain section" mode. |
| `src/components/ui-kit/index.ts` | Export `Chip`, `CountBadge`, `ReadOnlyValue`. |
| `src/components/ui-kit/client.ts` | Export `Tooltip`. |
| `src/app/(app)/quotes/[documentId]/page.tsx` | Split into three tab panels; delete the duplicated status/action blocks. |
| `src/app/(app)/quotes/[documentId]/loading.tsx` | Skeleton matches the new grid. |
| `src/components/builder/items-list.tsx` | Reduced to a list that renders `ItemCard`; drag logic moves to the hook. |
| `src/components/builder/items-section.tsx` | Section header with the single collapse toggle; no wrapper card. |
| `src/components/builder/item-options-editor.tsx` | Deleted once `options-sheet.tsx` and `item-panel-options.tsx` replace it. |
| `src/components/builder/production-spec-editor.tsx` | Field rendering moves to `item-panel-spec.tsx`; the file keeps only field definitions and validation. |
| `src/components/builder/item-breakdown-editor.tsx` | Rows move to `item-panel-price.tsx`; `EditablePrice` keeps its own file-local home there with an always-visible pencil. |
| `src/components/builder/finalize-button.tsx` | Takes `ReadinessRow[]` instead of two ad-hoc blocker strings. |
| `src/components/builder/sticky-footer.tsx` | `DocumentTotals` stays; `StickyFooter` becomes the mobile total dock. |

### Deleted

`src/components/builder/item-options-editor.tsx` (replaced by
`options-sheet.tsx` + `item-panel-options.tsx`).

---

## Status — 2026-09-22, complete

Every task above is done and on `redesign/quote-builder-ux`. Four things
landed differently from the plan, each for a reason found while building:

- **Task 8, the options sheet.** The plan assumed Base UI's `Dialog`. Its
  popup would not take the viewport as its containing block in this tree --
  a `fixed inset-0` diagnostic painted a box a few hundred pixels to the
  right -- so the first attempt was reverted and the sheet rebuilt on a
  native `<dialog>` opened with `showModal()`, which is painted in the top
  layer, outside every ancestor's stacking context. Escape, the focus trap,
  focus restoration and inerting the page come with it; both transitions are
  CSS (`@starting-style` + `allow-discrete`) with no "closing" state in
  React. `item-options-editor.tsx` was not deleted and replaced by
  `options-sheet.tsx`; it kept its name and grew a `SideSheet` around its
  existing list.
- **Task 7, the sub-tabs.** Options is a tab whose panel holds the item's
  option chips and the button that opens the sheet, rather than the option
  list itself. An EasyLoader opens on its Builder tab instead of Options,
  because that is where an EasyLoader is assembled and priced.
- **Task 9, Escape.** Cancelling a keyboard reorder commits the order
  remembered at pick-up rather than discarding an uncommitted draft: a move
  held only in local state is reverted by the next server render the moment
  anything else on the page saves.
- **Task 11, step 2.** The screenshots were not saved to
  `docs/redesign/after/`. The browser in use could not be resized, so each
  width was rendered in an iframe of that width instead and checked for
  horizontal overflow programmatically -- /quotes, /clients, /catalog,
  /documents, /settings, /settings/users, the builder on all three tabs and
  the quotation preview, all clean at 390, 768, 1024 and 1440.

Two fixes were found along the way that the plan did not anticipate:

- The full-bleed quote bar measured `50vw`, which is wider than the content
  region by the whole sidebar. Nothing showed the overhang while the root
  refused to scroll horizontally -- and then a confirm dialog's scroll lock
  made it scrollable for a moment and the page slid sideways and stayed
  there. It measures `cqw` now.
- The scroll lock behind the sheet was on `body`, whose `overflow` only
  propagates to the viewport while the root's own is `visible` -- and this
  app's root carries `overflow-x: clip`. It moved to the root, and the
  sidebar, a scroll container of its own that a modal dialog does not
  freeze, got a rule of its own.

---

## Task 1: Design tokens

**Files:**
- Modify: `src/app/globals.css:15-75` (the `@theme inline` block) and `src/app/globals.css:150-160` (the `@layer base` body rule)

- [x] **Step 1: Add shape, surface, divider and motion tokens**

In `src/app/globals.css`, inside `@theme inline`, after the existing
`--color-commission` line, add:

```css
  /* ── Surfaces ──────────────────────────────────────────────────────────
     Three levels, and nesting depth picks the level. The page is surface 0,
     a card is surface 1, a panel inside a card is surface 2. Before this,
     the builder had nine different wrapper treatments because every author
     picked bg + border + radius + padding by hand at each nesting depth. */
  --color-surface-0: oklch(0.977 0.002 247);  /* page background */
  --color-surface-1: #ffffff;                 /* card */
  --color-surface-2: oklch(0.974 0.003 247);  /* inset panel inside a card */

  /* ── Lines ─────────────────────────────────────────────────────────────
     One border colour and one divider colour. The builder previously used
     slate-100 and slate-200 interchangeably for dividers, and slate-200 and
     slate-300 interchangeably for input borders. */
  --color-line: oklch(0.917 0.005 247);        /* card + control borders */
  --color-divider: oklch(0.944 0.004 247);     /* hairlines inside a card */

  /* ── Control heights ───────────────────────────────────────────────────
     Two, not six. 44px is the touch target the app committed to and the
     default everywhere; 36px is allowed only at `sm:` and up, and only
     where a control sits in a dense row of its own kind. */
  --size-control: 2.75rem;        /* 44px */
  --size-control-dense: 2.25rem;  /* 36px */

  /* ── Motion ────────────────────────────────────────────────────────────
     Feedback only. The builder is opened dozens of times a day, so nothing
     animates on load, nothing loops, and nothing moves without the user
     having done something. Easing follows the standard split: ease-out for
     anything entering or leaving, ease-in-out for something already on
     screen that moves. */
  --duration-micro: 120ms;    /* press feedback */
  --duration-ui: 180ms;       /* disclosure, tab swap */
  --duration-overlay: 220ms;  /* sheet, dialog, popover */
  --ease-out-soft: cubic-bezier(0.215, 0.61, 0.355, 1);
  --ease-move: cubic-bezier(0.645, 0.045, 0.355, 1);
```

- [x] **Step 2: Collapse the radius scale to three**

Replace the existing radius block in `@theme inline` (the
`--radius-sm` … `--radius-4xl` run) with:

```css
  /* Three radii, named by what they are for. `--radius` stays defined
     because shadcn-derived components (Button, and the Base UI wrappers)
     read it; the three below are what application code uses.

     Previously one builder screen carried five: rounded-lg x35,
     rounded-xl x10, rounded-full x9, rounded-md x7 and bare rounded x2. */
  --radius: 0.625rem;
  --radius-control: 0.5rem;   /* 8px  - inputs, buttons, chips-with-corners */
  --radius-card: 0.75rem;     /* 12px - cards, sheets, dialogs */
  --radius-pill: 9999px;      /* badges, chips, meters */
  /* Kept for the shadcn Button's own size variants, which interpolate it. */
  --radius-md: calc(var(--radius) * 0.8);
```

- [x] **Step 3: Turn on the font that is already being downloaded**

`layout.tsx` already loads Geist and Geist Mono through `next/font/google`
and puts `--font-geist-sans` on `<html>`. `globals.css` then overrides
`body` to Segoe UI, so the download is paid for and thrown away. In the
`@layer base` block, replace:

```css
  body {
    @apply bg-background text-foreground;
    font-family: "Segoe UI", "Source Sans 3", system-ui, sans-serif;
  }
```

with:

```css
  body {
    @apply bg-background text-foreground;
    /* Geist is loaded by next/font in layout.tsx and was previously
       overridden here, so the app shipped the font and then rendered in
       Segoe UI. Geist is the better fit for a figure-heavy screen: its
       digits are the same width by default and its zero is slashed, which
       matters in a price column. The system stack stays as the fallback
       for the moment before the font file lands. */
    font-family: var(--font-geist-sans), "Segoe UI", system-ui, sans-serif;
  }
  /* Money and codes are read by column, not by word. */
  .tabular {
    font-variant-numeric: tabular-nums;
  }
```

- [x] **Step 4: Add the global reduced-motion escape hatch**

At the end of `src/app/globals.css`, after the `@layer utilities` block:

```css
/* Every animated thing in the app also carries its own `motion-reduce:`
   variant. This is the backstop: a user who asks for reduced motion gets
   none, including from any future component that forgets the variant.
   Deliberately not `!important`, because a component that genuinely needs motion
   for meaning can still opt back in explicitly. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
    transition-duration: 0.01ms;
    scroll-behavior: auto;
  }
}
```

- [x] **Step 5: Verify nothing moved**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass. A CSS-only change cannot fail typecheck, so this is
really checking that Tailwind v4 accepts the new `@theme` entries; a
malformed token makes `build` fail at the PostCSS step.

- [x] **Step 6: Walk every screen at two widths**

With the Chrome tools, at 1440px and then 390px, load and screenshot:
`/quotes`, `/quotes/cmubyqmdr004cft9kg60mbmfp`, `/clients`, `/catalog`,
`/documents`, `/settings`, `/settings/users`.
Expected: identical layout to before; the only visible difference is the
typeface. If any screen shifts, a token name collided with one Tailwind was
already generating utilities from. Rename it rather than removing it.

- [x] **Step 7: Commit**

```bash
git add src/app/globals.css
git commit -m "style: give the app one shape scale, one line colour and one motion vocabulary

One builder screen carried five radii, two divider colours and two input
border colours, because every author picked bg + border + radius by hand at
each nesting depth. Three surfaces, one line token and one divider token
replace the guessing: nesting depth picks the surface.

Geist has been downloaded by next/font since the scaffold and thrown away by
a body font-family override two lines later, so the app paid for a webfont
and rendered in Segoe UI. It is now what renders, which also gets the price
columns tabular figures by default.

Motion tokens are feedback-only on purpose: this screen is opened dozens of
times a day, so nothing here animates on load or loops."
```

---

## Task 2: Button reaches 44px and knows the brand colour

**Files:**
- Modify: `src/components/ui/button.tsx:44-56` (the `size` variants) and `:10-40` (the `variant` map)

The largest size is `h-9` (36px) against the app's own 44px touch rule, so
every builder call site overrides it with `className="h-11 …"`. There is no
`brand` variant, so `bg-brand text-white hover:bg-brand/90` is written by
hand in `finalize-button.tsx:71`, `client-section.tsx:397`,
`client-section.tsx:470` and `item-options-editor.tsx` (the drawer footer).

- [x] **Step 1: Add the touch sizes**

In `buttonVariants`, inside `size`, add two entries after `lg`:

```ts
        // The app's touch-target rule is 44px, but the largest size here was
        // 36px, so every call site in the builder overrode it with an inline
        // `h-11`. These two are that override, promoted to the API.
        touch: "h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        "icon-touch": "size-11",
```

- [x] **Step 2: Add the brand variant**

In `buttonVariants`, inside `variant`, after `success`:

```ts
        // The one primary action on a screen (Finalize, Save company). Brand
        // navy on white is 11.7:1, so the label is safe at any size. Written
        // out four times as `bg-brand text-white hover:bg-brand/90` before
        // this existed, which is how two of those four drifted to a
        // different hover opacity.
        brand:
          "bg-brand text-white hover:bg-[color-mix(in_oklch,var(--color-brand),black_12%)] focus-visible:border-brand focus-visible:ring-brand/30",
```

- [x] **Step 3: Add press feedback to the base class**

In the `cva` base string, replace `transition-all` with:

```
transition-[background-color,border-color,box-shadow,transform] duration-(--duration-micro) ease-(--ease-out-soft) motion-reduce:transition-none
```

and replace `active:not-aria-[haspopup]:translate-y-px` with:

```
active:not-aria-[haspopup]:scale-[0.97]
```

A 1px nudge is below the threshold most people notice; a 3% squash reads as
the button taking the press. `not-aria-[haspopup]` stays so a menu trigger
does not squash while its popup opens.

- [x] **Step 4: Sweep the call sites**

Run: `rg -n 'className="h-11|className=\{cn\("h-11|bg-brand text-white' src/components src/app`

For every hit, replace the inline override with the variant or size prop:
`className="h-11 w-full bg-brand text-white hover:bg-brand/90"` becomes
`size="touch" variant="brand" className="w-full"`. Leave `h-11` on raw
`<input>`/`<label>` elements alone; this step is only about `<Button>`.

- [x] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all pass.

Then in the browser at 1440px and 390px, press Finalize on
`/quotes/cmubyqmdr004cft9kg60mbmfp` (cancel the confirm dialog) and confirm
the squash reads as a press and the confirm dialog's own buttons are 44px.

- [x] **Step 6: Commit**

```bash
git add src/components/ui/button.tsx src/components src/app
git commit -m "refactor(ui): let Button reach the touch target it is always overridden to

The largest CVA size was 36px against the app's own 44px rule, so every
builder call site wrote className=\"h-11\" and the size prop did nothing.
There was also no brand variant, so bg-brand text-white hover:bg-brand/90 was
typed out four times, and two of those four had drifted to a different hover.

Both are now part of the API and the overrides are deleted. Press feedback
moves from translate-y-px, which is below the threshold most people notice,
to a 3% squash that reads as the button taking the press."
```

---

## Task 3: ui-kit primitives

**Files:**
- Create: `src/components/ui-kit/tooltip.tsx`, `src/components/ui-kit/chip.tsx`, `src/components/ui-kit/read-only-value.tsx`
- Modify: `src/components/ui-kit/field-row.tsx`, `src/components/ui-kit/index.ts`, `src/components/ui-kit/client.ts`

- [x] **Step 1: Tooltip**

Create `src/components/ui-kit/tooltip.tsx`:

```tsx
"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";

/**
 * A label for a control that carries no visible text. The builder's item
 * action row is three icon buttons, and before this the app's only answer
 * was the native `title` attribute (send-to-client-button.tsx, app-nav.tsx's
 * icon rail), which has no styling, no touch behaviour and an unpredictable
 * delay.
 *
 * 500ms is deliberate: long enough that moving the pointer across the row
 * does not trail a string of tooltips, short enough that someone who has
 * paused is not left waiting. `aria-label` on the trigger is what a screen
 * reader reads; this is for sighted users, which is why the content is not
 * also announced.
 */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Root delay={500}>
      <TooltipPrimitive.Trigger render={children as React.ReactElement} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={6}>
          <TooltipPrimitive.Popup
            className={cn(
              "rounded-(--radius-control) bg-brand-dark px-2.5 py-1.5 text-xs font-medium text-white shadow-lg",
              "transition-[opacity,transform] duration-(--duration-micro) ease-(--ease-out-soft) motion-reduce:transition-none",
              "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
            )}
          >
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** Wrap the screen (or the app layout) once so tooltips share a delay group:
 *  after one has opened, the next opens immediately rather than re-waiting. */
export const TooltipProvider = TooltipPrimitive.Provider;
```

- [x] **Step 2: Chip and CountBadge**

Create `src/components/ui-kit/chip.tsx`:

```tsx
import { cn } from "@/lib/utils";

/**
 * A neutral fact, not a state: an option name on a collapsed machine, a
 * filter that is applied. `StatusBadge` is the one for state (DRAFT, SIGNED,
 * price required) and carries semantic colour; a Chip never does.
 *
 * The builder had four parallel implementations of this shape before:
 * options chips at py-1, the item meta pill at px-2, the count badge, and
 * the inline status pills, differing only in padding.
 */
export function Chip({
  children,
  trailing,
  className,
}: {
  children: React.ReactNode;
  /** A figure that belongs to the chip's subject, e.g. an option's price. */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-(--radius-pill) bg-slate-100 px-2.5 text-xs font-medium whitespace-nowrap text-slate-600",
        className
      )}
    >
      {children}
      {trailing ? <span className="tabular text-slate-500">{trailing}</span> : null}
    </span>
  );
}

/** A count beside a label: a tab's item count, a disclosure's option count. */
export function CountBadge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "brand" }) {
  return (
    <span
      className={cn(
        "inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-(--radius-pill) px-1.5 text-[0.6875rem] font-semibold tabular",
        tone === "brand" ? "bg-brand/10 text-brand" : "bg-slate-100 text-slate-600"
      )}
    >
      {children}
    </span>
  );
}
```

- [x] **Step 3: ReadOnlyValue**

Create `src/components/ui-kit/read-only-value.tsx`:

```tsx
import { cn } from "@/lib/utils";

/**
 * How a FINAL document renders a setting that a DRAFT renders as a control.
 *
 * Six components each invented their own shape for this: PriceDisplayToggles
 * collapsed to one sentence, DeliveryTermsField to "Delivered.",
 * ValidityDaysField to "Valid for N days.", NotesSection to prose or "No
 * notes.", TermsDocumentsPanel to a <dl> plus a bullet list, ClientSection to
 * a bare line. A read-only quote consequently looked like six different
 * documents stapled together.
 */
export function ReadOnlyValue({
  label,
  children,
  empty = "Not set",
  className,
}: {
  label: string;
  /** The value. `null`/`undefined`/`""` renders `empty` in muted type. */
  children?: React.ReactNode;
  empty?: string;
  className?: string;
}) {
  const isEmpty = children === null || children === undefined || children === "";
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className={cn("m-0 text-sm", isEmpty ? "text-slate-400" : "text-brand-dark")}>
        {isEmpty ? empty : children}
      </dd>
    </div>
  );
}
```

- [x] **Step 4: FieldRow gains an inline layout**

In `src/components/ui-kit/field-row.tsx`, add `layout` to the props type and
to the destructure, defaulting to `"stacked"`, then replace the returned
wrapper and label with:

```tsx
    <div
      className={cn(
        layout === "inline"
          ? "grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-x-3"
          : "flex flex-col gap-1.5",
        className
      )}
    >
      <label
        htmlFor={htmlFor}
        className={cn("text-sm font-medium text-brand-dark", layout === "inline" && "sm:py-2")}
      >
```

and give the error/hint paragraphs `layout === "inline" && "sm:col-start-2"`.

This replaces three hand-rolled label-left layouts:
`production-spec-editor.tsx:73-90`'s `CompactField` (`w-44`),
`terms-documents-panel.tsx:219-222`'s `sm:grid-cols-[8rem_1fr]`, and the
label-wraps-input rows in `item-discount-field.tsx` and
`price-display-toggles.tsx`.

- [x] **Step 5: Point fieldInputClass at the tokens**

In the same file, replace the `fieldInputClass` constant with:

```ts
export const fieldInputClass =
  "h-(--size-control) w-full rounded-(--radius-control) border border-line bg-white px-3 text-base text-brand-dark outline-none transition-colors duration-(--duration-micro) motion-reduce:transition-none placeholder:text-slate-500 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60";
```

Then sweep the inputs that were never using it:
`rg -n 'border-slate-300' src/components` and replace each with `border-line`.

- [x] **Step 6: Export**

In `src/components/ui-kit/index.ts` add:

```ts
export { Chip, CountBadge } from "./chip";
export { ReadOnlyValue } from "./read-only-value";
```

In `src/components/ui-kit/client.ts` add:

```ts
export { Tooltip, TooltipProvider } from "./tooltip";
```

`Tooltip` goes in the client barrel, not the server one, for the reason that
barrel's header already documents: it carries `"use client"` and its own
module graph, and a server component pulling `FieldRow` must not drag it in.

- [x] **Step 7: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: all pass. If `@base-ui/react/tooltip` does not resolve, check the
installed version exports it: `rg '"exports"' -A40 node_modules/@base-ui/react/package.json | rg tooltip`.

- [x] **Step 8: Commit**

```bash
git add src/components/ui-kit
git commit -m "feat(ui-kit): add Chip, CountBadge, Tooltip and ReadOnlyValue, and give FieldRow an inline layout

Four shapes existed in the builder as four to six hand-rolled copies each,
differing only in padding, and a read-only FINAL quote rendered as six
different documents stapled together because every section invented its own
read-only presentation.

FieldRow's inline layout replaces three separate label-left implementations:
production-spec-editor's CompactField, terms-documents-panel's own grid, and
the label-wraps-input rows in the two discount fields.

Tooltip exists because the app's only answer for an unlabelled control was
the native title attribute, which the icon-only action row coming next cannot
use."
```

---

## Task 4: The readiness predicate (TDD)

**Files:**
- Create: `src/lib/quote-readiness.ts`, `tests/quote-readiness.test.ts`

This is the load-bearing unit. `FinalizeButton` currently receives two
ad-hoc strings computed inline in `page.tsx:665-679`, and the server
re-derives its own answer in `src/lib/actions/finalize.ts`. The panel adding
a third derivation would guarantee the three disagree. One pure function,
two consumers.

- [x] **Step 1: Write the failing test**

Create `tests/quote-readiness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { quoteReadiness, type ReadinessInput } from "../src/lib/quote-readiness";

// Pure module: no Prisma, no DATABASE_URL, same discipline as
// tests/production-readiness.test.ts which covers the function this wraps.

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    hasCompany: true,
    hasContact: true,
    items: [
      {
        id: "i1",
        name: "X-Calibre Cutting Machine",
        code: "X-10180",
        form: "X_CALIBRE",
        productionSpec: { cuttingWidth: 1800, voltage: "415V" },
        options: [],
        unitPriceCents: 31619000,
      },
    ],
    deliveryTermsSet: true,
    printedDocumentCount: 3,
    capExceeded: false,
    exceedsMarkupCap: false,
    ...over,
  };
}

describe("quoteReadiness", () => {
  it("reports every row even when all are met", () => {
    const rows = quoteReadiness(input());
    expect(rows.map((r) => r.key)).toEqual([
      "client",
      "items",
      "spec",
      "delivery",
      "documents",
    ]);
    expect(rows.every((r) => r.met)).toBe(true);
  });

  it("keeps a stable order so the panel does not reshuffle as rows are met", () => {
    const a = quoteReadiness(input()).map((r) => r.key);
    const b = quoteReadiness(input({ hasContact: false })).map((r) => r.key);
    expect(a).toEqual(b);
  });

  it("fails the client row when the company is set but the contact is not", () => {
    const row = quoteReadiness(input({ hasContact: false })).find((r) => r.key === "client");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("No contact selected");
  });

  it("fails the items row on an empty quote", () => {
    const row = quoteReadiness(input({ items: [] })).find((r) => r.key === "items");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("No machines yet");
  });

  it("fails the items row when a machine has no price", () => {
    const rows = quoteReadiness(
      input({ items: [{ ...input().items[0], unitPriceCents: 0 }] })
    );
    const row = rows.find((r) => r.key === "items");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("X-10180 has no price");
  });

  it("names the machine and the field count on an incomplete production spec", () => {
    const rows = quoteReadiness(
      input({ items: [{ ...input().items[0], productionSpec: {} }] })
    );
    const row = rows.find((r) => r.key === "spec");
    expect(row?.met).toBe(false);
    expect(row?.detail).toContain("X-10180");
    expect(row?.targetItemId).toBe("i1");
  });

  it("points at the first offending machine when several are incomplete", () => {
    const base = input().items[0];
    const rows = quoteReadiness(
      input({
        items: [
          { ...base, id: "i1", productionSpec: { cuttingWidth: 1800, voltage: "415V" } },
          { ...base, id: "i2", code: "M-3220", productionSpec: {} },
          { ...base, id: "i3", code: "L-220", productionSpec: {} },
        ],
      })
    );
    const row = rows.find((r) => r.key === "spec");
    expect(row?.targetItemId).toBe("i2");
    expect(row?.detail).toContain("2 machines");
  });

  it("treats the discount cap as a hard blocker separate from the rows", () => {
    expect(quoteReadiness(input({ capExceeded: true })).every((r) => r.met)).toBe(true);
    expect(isFinalizable(input({ capExceeded: true }))).toBe(false);
    expect(isFinalizable(input())).toBe(true);
  });
});

import { isFinalizable } from "../src/lib/quote-readiness";

describe("isFinalizable", () => {
  it("is false while any row is unmet", () => {
    expect(isFinalizable(input({ items: [] }))).toBe(false);
  });

  it("does not block on the documents row, which is advisory", () => {
    expect(isFinalizable(input({ printedDocumentCount: 0 }))).toBe(true);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/quote-readiness.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/quote-readiness'`.

- [x] **Step 3: Write the module**

Create `src/lib/quote-readiness.ts`:

```ts
import { itemMissing, type ReadinessItem } from "@/lib/production-forms/readiness";

/**
 * What still stands between this quote and Finalize, as an ordered list the
 * builder's rail renders directly.
 *
 * This exists because the answer was previously derived in three places:
 * inline in the quote page (page.tsx, feeding FinalizeButton two ad-hoc
 * strings), again server-side in finalizeDocument, and, had the rail
 * computed its own, a third time. Two of those three would eventually
 * disagree, and the one the user sees is the one that would be wrong.
 *
 * Pure on purpose: no React, no Prisma client, no formatting of money. The
 * caller passes a summary it already has in hand and gets back rows.
 */
export type ReadinessKey = "client" | "items" | "spec" | "delivery" | "documents";

export type ReadinessRow = {
  key: ReadinessKey;
  label: string;
  met: boolean;
  /** One short line naming what is missing. Null when the row is met. */
  detail: string | null;
  /** Which tab the fix lives on, so the panel can link to it. */
  targetTab: "build" | "terms";
  /** The item to expand and scroll to, when the fix is inside one machine. */
  targetItemId: string | null;
  /** False for an advisory row: shown, but never blocks Finalize. */
  blocking: boolean;
};

export type ReadinessInput = {
  hasCompany: boolean;
  hasContact: boolean;
  items: Array<
    ReadinessItem & {
      id: string;
      name: string;
      unitPriceCents: number;
    }
  >;
  deliveryTermsSet: boolean;
  printedDocumentCount: number;
  /** Over the region's discount cap. A hard stop, not a row. */
  capExceeded: boolean;
  exceedsMarkupCap: boolean;
};

export function quoteReadiness(input: ReadinessInput): ReadinessRow[] {
  const rows: ReadinessRow[] = [];

  const clientDetail = !input.hasCompany
    ? "No company selected"
    : !input.hasContact
      ? "No contact selected"
      : null;
  rows.push({
    key: "client",
    label: "Client and contact",
    met: clientDetail === null,
    detail: clientDetail,
    targetTab: "build",
    targetItemId: null,
    blocking: true,
  });

  const unpriced = input.items.find((item) => item.unitPriceCents <= 0);
  const itemsDetail =
    input.items.length === 0
      ? "No machines yet"
      : unpriced
        ? `${unpriced.code} has no price`
        : null;
  rows.push({
    key: "items",
    label: input.items.length === 1 ? "1 machine priced" : `${input.items.length} machines priced`,
    met: itemsDetail === null,
    detail: itemsDetail,
    targetTab: "build",
    targetItemId: unpriced?.id ?? null,
    blocking: true,
  });

  // `itemMissing` is the same per-item check finalizeDocument enforces
  // through `productionIssues`; calling it directly is what keeps the panel
  // and the server from drifting.
  const incomplete = input.items
    .map((item) => ({ item, missing: itemMissing(item) }))
    .filter((entry) => entry.missing.length > 0);
  const specDetail =
    incomplete.length === 0
      ? null
      : incomplete.length === 1
        ? `${incomplete[0].item.code}: ${fieldCount(incomplete[0].missing.length)}`
        : `${incomplete.length} machines incomplete, starting with ${incomplete[0].item.code}`;
  rows.push({
    key: "spec",
    label: "Production spec",
    met: incomplete.length === 0,
    detail: specDetail,
    targetTab: "build",
    targetItemId: incomplete[0]?.item.id ?? null,
    blocking: true,
  });

  rows.push({
    key: "delivery",
    label: "Delivery terms",
    met: input.deliveryTermsSet,
    detail: input.deliveryTermsSet ? null : "Not chosen",
    targetTab: "terms",
    targetItemId: null,
    blocking: true,
  });

  // Advisory: a quote with no legal documents attached is unusual but legal,
  // and finalizeDocument does not refuse it. Showing it as a row is the
  // point: it is the kind of omission nobody notices until the customer
  // does.
  rows.push({
    key: "documents",
    label: "Legal documents",
    met: input.printedDocumentCount > 0,
    detail:
      input.printedDocumentCount > 0
        ? `${input.printedDocumentCount} will print`
        : "None will print",
    targetTab: "terms",
    targetItemId: null,
    blocking: false,
  });

  return rows;
}

function fieldCount(n: number): string {
  return n === 1 ? "1 field empty" : `${n} fields empty`;
}

/** The single verdict Finalize is gated on. */
export function isFinalizable(input: ReadinessInput): boolean {
  if (input.capExceeded || input.exceedsMarkupCap) return false;
  return quoteReadiness(input).every((row) => !row.blocking || row.met);
}
```

- [x] **Step 4: Run the test again**

Run: `npx vitest run tests/quote-readiness.test.ts`
Expected: PASS, 10 tests.

If the `detail` strings do not match, fix the module, not the test. The
strings are what the user reads and the test is where they are specified.

- [x] **Step 5: Type-check the tests**

Run: `npx tsc -p tests --noEmit`
Expected: no output. (`vitest.config.ts` documents that test types are
checked here, not by vitest's own `typecheck`.)

- [x] **Step 6: Commit**

```bash
git add src/lib/quote-readiness.ts tests/quote-readiness.test.ts
git commit -m "feat: derive 'what is stopping this quote finalizing' in one place

The answer was computed inline in the quote page to feed FinalizeButton two
ad-hoc strings, and again server-side in finalizeDocument. The readiness
panel that follows would have been a third derivation, and two of three
eventually disagree, with the one the user reads being the wrong one.

quoteReadiness returns ordered rows with a stable key order, so the panel
does not reshuffle as rows are satisfied, and each row carries where its fix
lives: which tab, and which machine to expand. The documents row is
deliberately advisory: a quote with no legal documents attached is unusual
but not refused, and it is exactly the omission nobody notices until the
customer does."
```

---

## Task 5: Quote bar and three tabs

**Files:**
- Create: `src/components/builder/quote-bar.tsx`, `src/components/builder/builder-tabs.tsx`
- Modify: `src/app/(app)/quotes/[documentId]/page.tsx`

- [x] **Step 1: Build the tab strip**

Create `src/components/builder/builder-tabs.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui-kit";

export type BuilderTab = "build" | "terms" | "history";

const TABS: Array<{ id: BuilderTab; label: string }> = [
  { id: "build", label: "Build" },
  { id: "terms", label: "Quote terms" },
  { id: "history", label: "History" },
];

export function parseTab(value: string | null): BuilderTab {
  return value === "terms" || value === "history" ? value : "build";
}

/**
 * The builder's three tabs, with the active one in the URL as `?tab=`.
 *
 * In the URL rather than in state so the browser's back button steps between
 * tabs instead of leaving the quote, and so a link to a quote's terms can be
 * sent to someone. `scroll: false` because switching tabs is not navigation
 * to a new document and should not jump the page to the top.
 *
 * The route itself is untouched: `/quotes/[documentId]` still resolves the
 * same server component, which renders all three panels and lets this hide
 * two of them.
 */
export function BuilderTabs({ counts }: { counts: Partial<Record<BuilderTab, number>> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = parseTab(params.get("tab"));

  function select(tab: BuilderTab) {
    const next = new URLSearchParams(params.toString());
    if (tab === "build") next.delete("tab");
    else next.set("tab", tab);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div role="tablist" aria-label="Quote sections" className="flex px-4 md:px-6">
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`builder-panel-${tab.id}`}
            id={`builder-tab-${tab.id}`}
            onClick={() => select(tab.id)}
            className={cn(
              "focus-ring -mb-px flex min-h-11 items-center gap-2 border-b-2 px-3.5 pb-2.5 text-sm transition-colors duration-(--duration-micro) motion-reduce:transition-none",
              selected
                ? "border-brand font-semibold text-brand"
                : "border-transparent font-medium text-slate-500 md:hover:text-brand-dark"
            )}
          >
            {tab.label}
            {counts[tab.id] ? <CountBadge>{counts[tab.id]}</CountBadge> : null}
          </button>
        );
      })}
    </div>
  );
}
```

- [x] **Step 2: Build the quote bar**

Create `src/components/builder/quote-bar.tsx`. It renders, in one sticky
row: back link, company name, quote number plus contact plus region, the
autosave indicator, the status badge, the grand total, and the primary
action passed in as `children`. Below it, `<BuilderTabs>`.

```tsx
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { BuilderTabs, type BuilderTab } from "./builder-tabs";

/**
 * Identity, state and the primary action, on one sticky line at every width.
 *
 * Replaces two blocks that were rendered twice in the DOM and toggled by
 * `hidden lg:block` / `lg:hidden`, which is why a tablet between 768 and
 * 1023px got the single-column layout, the desktop icon rail, and no total
 * anywhere on the screen.
 *
 * Deliberately no save indicator. Every field that autosaves already shows
 * its own `AutosaveIndicator` next to itself, which is where the feedback
 * belongs; a second one up here would report on a field the user may not be
 * looking at, and a permanent "Saved" that is true almost all of the time
 * carries no information while taking a slot in the busiest row on the page.
 */
export function QuoteBar({
  companyName,
  number,
  contactName,
  regionName,
  status,
  total,
  tabCounts,
  children,
}: {
  companyName: string;
  number: string | null;
  contactName: string | null;
  regionName: string | null;
  status: string;
  /** Already formatted, e.g. "A$932,497.48". */
  total: string;
  tabCounts: Partial<Record<BuilderTab, number>>;
  /** The primary action for the current status (Finalize, or Send). */
  children: React.ReactNode;
}) {
  const meta = [number, contactName, regionName].filter(Boolean);
  return (
    <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-white md:-mx-6 lg:-mx-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 md:px-6 lg:px-8">
        <div className="min-w-0 flex-1">
          <Link
            href="/quotes"
            className="focus-ring inline-flex items-center gap-1 rounded-(--radius-control) text-xs font-medium text-slate-500 transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:text-brand-dark"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Quotes
          </Link>
          <h1 className="truncate text-base font-semibold text-brand-dark">{companyName}</h1>
          {meta.length > 0 ? (
            <p className="truncate text-xs text-slate-500">{meta.join(" · ")}</p>
          ) : null}
        </div>
        <StatusBadge tone={STATUS_TONE[status]}>{status}</StatusBadge>
        <div className="text-right">
          <p className="text-[0.625rem] font-semibold tracking-wider text-slate-500 uppercase">
            Total incl. GST
          </p>
          <p className="tabular text-lg font-semibold text-brand-dark">{total}</p>
        </div>
        {children}
      </div>
      <BuilderTabs counts={tabCounts} />
    </div>
  );
}
```

- [x] **Step 3: Restructure the page**

In `src/app/(app)/quotes/[documentId]/page.tsx`:

1. Delete the `PageHeader` at line 253 and the mobile `Status & actions`
   block at lines 464-478. Both are now the quote bar.
2. Read the tab: `const tab = parseTab((await searchParams).tab ?? null);`
   and add `searchParams` to the page's props alongside `params`.
3. Wrap the existing left-column sections in
   `<div role="tabpanel" id="builder-panel-build" aria-labelledby="builder-tab-build" hidden={tab !== "build"}>`,
   keeping Client, Items and Extra inside it.
4. Move these seven `SectionCard`s into a `builder-panel-terms` panel, in
   this order: Discounts, Delivery terms, Quote validity, Notes, Terms and
   documents, Setup image, Quotation pricing display.
5. Move `RevisionsSection`, `ProductionFormsSection` and
   `EmailHistorySection` into a `builder-panel-history` panel.
6. Render all three panels server-side and hide two with `hidden`, rather
   than conditionally rendering. A `hidden` panel costs nothing to render
   here (the data is already fetched in the single `Promise.all` at
   `page.tsx:177-213`) and it keeps the tab switch instant.

- [x] **Step 4: Fix the skeleton to match**

In `src/app/(app)/quotes/[documentId]/loading.tsx`, change the card class
from `rounded-xl border border-slate-200 bg-white p-4` to
`rounded-(--radius-card) border border-line bg-white p-4 sm:p-6` and add a
bar at the top standing in for the quote bar. The skeleton was already
missing `sm:p-6`, so it did not match the real cards above the `sm`
breakpoint.

- [x] **Step 5: Verify in the browser**

At 1440px, 1024px, 768px and 390px on
`/quotes/cmubyqmdr004cft9kg60mbmfp`:
- the total is visible at every width, including 768-1023px
- clicking Quote terms puts `?tab=terms` in the URL, the browser back button
  returns to Build, and the page does not jump to the top
- reloading on `?tab=history` lands on History
- `?tab=nonsense` falls back to Build without an error

- [x] **Step 6: Commit**

```bash
git add src/components/builder/quote-bar.tsx src/components/builder/builder-tabs.tsx "src/app/(app)/quotes/[documentId]"
git commit -m "feat(builder): split the quote screen into Build, Quote terms and History

The left column stacked eleven SectionCards in one flow, with Items in the
same visual register as Setup image and Email history. Three of those change
on every quote, seven are set once, two are read-only history, and they were
interleaved.

Status and actions were also rendered twice in the DOM and toggled by
hidden lg:block / lg:hidden, with the totals living only in the desktop copy,
so a tablet between 768 and 1023px got the single-column layout, the
desktop icon rail, and no total anywhere on screen. One sticky bar replaces
both copies at every width.

The tab is in the URL so back steps between tabs rather than leaving the
quote, and so a link to a quote's terms can be sent to someone. The route is
unchanged."
```

---

## Task 6: Readiness panel

**Files:**
- Create: `src/components/builder/readiness-panel.tsx`
- Modify: `src/app/(app)/quotes/[documentId]/page.tsx`, `src/components/builder/finalize-button.tsx`

- [x] **Step 1: Build the panel**

Create `src/components/builder/readiness-panel.tsx`. It takes
`rows: ReadinessRow[]`, renders a meter of met-over-blocking and one row
each. An unmet row with a `targetItemId` renders a button that dispatches a
`builder:reveal-item` CustomEvent with that id; an unmet row with only a
`targetTab` renders a link to `?tab=<target>`.

```tsx
"use client";

import { Check, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadinessRow } from "@/lib/quote-readiness";

/**
 * What is still missing, before the user presses Finalize rather than after.
 *
 * FinalizeButton reported its blockers only once it had been pressed and
 * refused, so "why can I not finalize" was a question the screen answered
 * last. The rows come from `quoteReadiness`, the same function the button's
 * own disabled state and the server action are derived from, so this can
 * never claim the quote is ready when finalize would refuse it.
 *
 * Reveal goes through a CustomEvent rather than lifting the items list's
 * expansion state up to the page: the list owns which machines are open, the
 * page does not need to know, and an event keeps that boundary intact.
 */
export function ReadinessPanel({ rows }: { rows: ReadinessRow[] }) {
  const blocking = rows.filter((row) => row.blocking);
  const met = blocking.filter((row) => row.met).length;

  return (
    <div>
      <div
        className="mb-3 h-1.5 overflow-hidden rounded-(--radius-pill) bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={blocking.length}
        aria-valuenow={met}
        aria-label={`${met} of ${blocking.length} requirements met`}
      >
        <div
          className="h-full rounded-(--radius-pill) bg-emerald-700 transition-[width] duration-(--duration-overlay) ease-(--ease-move) motion-reduce:transition-none"
          style={{ width: `${blocking.length ? (met / blocking.length) * 100 : 0}%` }}
        />
      </div>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-start gap-2.5 border-b border-divider py-2 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full",
                row.met ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
              )}
            >
              {row.met ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-brand-dark">{row.label}</span>
              {row.detail ? (
                <span className="block text-xs text-slate-500">{row.detail}</span>
              ) : null}
              {!row.met ? <RevealLink row={row} /> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RevealLink({ row }: { row: ReadinessRow }) {
  if (row.targetItemId) {
    return (
      <button
        type="button"
        className="focus-ring rounded text-xs font-semibold text-brand md:hover:underline"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("builder:reveal-item", { detail: { itemId: row.targetItemId } })
          )
        }
      >
        Go and fill it in
      </button>
    );
  }
  return (
    <a
      href={row.targetTab === "build" ? "?" : `?tab=${row.targetTab}`}
      className="focus-ring rounded text-xs font-semibold text-brand md:hover:underline"
    >
      Open {row.targetTab === "terms" ? "Quote terms" : "Build"}
    </a>
  );
}
```

- [x] **Step 2: Rewire FinalizeButton**

In `src/components/builder/finalize-button.tsx`, replace the `blocker` and
`capBlocker` props with `rows: ReadinessRow[]` and `capBlocker: string | null`.
The disabled condition becomes:

```tsx
const unmet = rows.filter((row) => row.blocking && !row.met);
...
disabled={pending || unmet.length > 0 || capBlocker !== null}
```

and the amber `role="status"` paragraph becomes:

```tsx
{unmet.length > 0 ? (
  <p role="status" className="text-sm text-amber-700">
    {unmet.length === 1
      ? `Complete before finalizing: ${unmet[0].label.toLowerCase()}.`
      : `${unmet.length} things to complete before finalizing.`}
  </p>
) : null}
```

Delete the inline `productionIssues(...)` IIFE at `page.tsx:665-679` and
pass the rows computed once near the top of the page component instead.

- [x] **Step 3: Mount the panel**

In `page.tsx`, add the panel as the first card in the right rail, above
Summary, inside a `SectionCard` titled "Readiness" with a
`{met} of {blocking.length}` description. The rail is `lg:` only, so on
mobile it also renders once inside the Build panel above the items.

- [x] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run test`

In the browser on `/quotes/cmubyqmdr004cft9kg60mbmfp`, which has an
incomplete production spec: the panel shows 4 of 5, the spec row names the
machine, and pressing "Go and fill it in" expands that machine and scrolls
it into view. Finalize is disabled with the amber line naming what is left.

- [x] **Step 5: Commit**

```bash
git add src/components/builder/readiness-panel.tsx src/components/builder/finalize-button.tsx "src/app/(app)/quotes/[documentId]/page.tsx"
git commit -m "feat(builder): show what is blocking Finalize before it is pressed

FinalizeButton reported its blockers only after being pressed and refused, so
'why can I not finalize this' was the last question the screen answered. The
rail now lists every precondition with the offending machine named, and each
unmet row opens the exact place the fix lives.

Both the panel and the button's disabled state read quoteReadiness, so the
panel cannot claim a quote is ready when finalize would refuse it. The inline
productionIssues IIFE in the page is gone with them."
```

---

## Task 7: The machine card

**Files:**
- Create: `src/components/builder/item-card.tsx`, `item-panel-options.tsx`, `item-panel-spec.tsx`, `item-panel-price.tsx`, `item-action-bar.tsx`
- Modify: `src/components/builder/items-list.tsx`, `src/components/builder/items-section.tsx`, `src/components/builder/item-breakdown-editor.tsx`, `src/components/builder/production-spec-editor.tsx`

- [x] **Step 1: Section header with one collapse control**

In `items-section.tsx`, drop the `SectionCard` wrapper. Render a header row
(title, count, the collapse toggle, Add machine) followed by `<ItemsList>`.
The toggle is one button whose label and icon both flip:

```tsx
<button
  type="button"
  aria-expanded={anyOpen}
  onClick={() => setAllOpen(!anyOpen)}
  className="focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-(--radius-control) px-2.5 text-sm font-medium text-slate-600 transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-slate-100 md:hover:text-brand-dark"
>
  {anyOpen ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
  {anyOpen ? "Collapse all" : "Expand all"}
</button>
```

This replaces the pair of text buttons separated by a literal `|` in a
`<span aria-hidden>` at `items-list.tsx:238-253`.

- [x] **Step 2: The card**

Create `item-card.tsx`. The header is a real button, not a clickable div:

```tsx
<article
  className={cn(
    "rounded-(--radius-card) border bg-white transition-colors duration-(--duration-micro) motion-reduce:transition-none",
    incomplete ? "border-amber-200" : "border-line",
    open && "border-slate-300"
  )}
>
  <div className="flex items-center gap-1 py-2.5 pr-3 pl-1.5">
    <DragHandle ... />
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
      className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-(--radius-control) p-1.5 text-left transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-slate-50"
    >
      {/* thumbnail */}
      <span className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-brand-dark">{item.name}</h3>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-slate-500">{item.code}</span>
          {optionChips}
          {specBadge}
          {item.noCommission ? <StatusBadge tone="amber">No commission</StatusBadge> : null}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="tabular block text-sm font-semibold text-brand-dark">{price}</span>
        <span className="tabular block text-xs text-slate-500">Qty {item.qty}</span>
      </span>
      <ChevronDown
        aria-hidden="true"
        className="size-4 shrink-0 text-slate-400 transition-transform duration-(--duration-ui) ease-(--ease-move) motion-reduce:transition-none"
        style={{ transform: open ? "rotate(180deg)" : undefined }}
      />
    </button>
  </div>
  <div
    id={panelId}
    className="grid transition-[grid-template-rows] duration-(--duration-ui) ease-(--ease-move) motion-reduce:transition-none"
    style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
  >
    <div className="overflow-hidden">
      <div
        className={cn(
          "border-t border-divider px-4 pt-4 pb-4 transition-[opacity,transform] duration-(--duration-ui) ease-(--ease-out-soft) motion-reduce:transition-none",
          open ? "opacity-100" : "-translate-y-1 opacity-0"
        )}
      >
        {/* sub-tabs, panel, action bar */}
      </div>
    </div>
  </div>
</article>
```

Four changes are carried here:
- the header is a `<button aria-expanded aria-controls>`, where it was a
  `<div onClick>` with no role, no `tabIndex` and no key handler, operable by
  keyboard only because a nested button's click bubbled
- the machine name is an `<h3>`, giving the items region an outline it did
  not have
- the collapsed row carries the option chips and the spec badge, so what is
  missing is visible without opening anything
- `noCommission` gets a text badge beside the existing amber wash, which was
  colour-only before

Keep the `grid-template-rows` disclosure: it is the only technique that
handles content of unknown height. The opacity and translate on the inner
element are what the eye reads as motion, and those are GPU-composited.

- [x] **Step 3: Sub-tabs**

Inside `item-card.tsx`, a `role="tablist"` of three buttons (Options, Spec,
Price) driving three panels. Local `useState`, not URL: which sub-tab of
which machine is open is not worth a URL entry, and three machines open at
once would need three parameters.

This replaces two sibling disclosures whose trigger buttons shared a
byte-identical class string (`item-options-editor.tsx:391-407` and
`production-spec-editor.tsx:421-444`) and were told apart only by label.

- [x] **Step 4: The action row**

Create `item-action-bar.tsx`: one flat row under the sub-tabs, no overflow
menu.

```tsx
<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-divider pt-3">
  <label htmlFor={discountId} className="text-xs font-medium text-slate-600">Discount</label>
  <input id={discountId} className={cn(fieldInputClass, "tabular h-9 w-16 px-2 text-right")} ... />
  <DiscountTypeToggle ... />
  <div className="ml-auto flex items-center gap-1">
    <Tooltip label={showImage ? "Hide photo in PDF" : "Show photo in PDF"}>
      <button type="button" aria-pressed={showImage} aria-label={...} className={iconBtn}>
        {showImage ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </button>
    </Tooltip>
    <Tooltip label="Duplicate machine">
      <button type="button" aria-label="Duplicate machine" className={iconBtn}>
        <Copy className="size-4" />
      </button>
    </Tooltip>
    <Tooltip label="Delete machine">
      <button type="button" aria-label={`Delete ${item.name}`} className={cn(iconBtn, "text-rose-600 md:hover:bg-rose-50")}>
        <Trash2 className="size-4" />
      </button>
    </Tooltip>
  </div>
</div>
```

where `iconBtn` is
`"focus-ring flex size-11 items-center justify-center rounded-(--radius-control) text-slate-500 transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-slate-100 md:hover:text-brand-dark"`.

Three points this encodes. The actions are global to the machine, so they sit
below the sub-tabs rather than inside Price, where the first draft put them.
A tab holds what its label names, and delete does not belong a mis-click away
from a number field. They are icons with `aria-label` and a delayed tooltip
rather than an overflow menu, because a popover would have to escape the
disclosure's `overflow-hidden` wrapper and because the row exists so that
every action is visible without a guess. The "max 10%" hint is dropped: it is
learned once, and it was competing for the same row.

Delete keeps its `useConfirm({ tone: "danger" })` from
`remove-item-button.tsx`. Duplicate is a new server action,
`duplicateItem(documentId, itemId)`, copying the item with its lines and
production spec and inserting it directly after the source.

- [x] **Step 5: Always-visible price pencil**

In `item-panel-price.tsx`, the `EditablePrice` trigger loses
`opacity-0 group-hover:opacity-100` (was `item-breakdown-editor.tsx:413`) and
becomes:

```tsx
<button
  type="button"
  aria-label={`Edit ${label} price`}
  className="focus-ring -mx-2 -my-1 inline-flex items-center gap-1.5 rounded-(--radius-control) px-2 py-1 text-sm font-medium text-brand-dark transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:bg-sky-50 md:hover:text-brand-accent-ink"
>
  {listPrice ? <span className="text-xs text-slate-400 line-through tabular">{listPrice}</span> : null}
  <span className="tabular">{price}</span>
  <Pencil className="size-3.5 opacity-40 transition-opacity duration-(--duration-micro) motion-reduce:transition-none group-hover:opacity-100" aria-hidden="true" />
</button>
```

Hover-only was not a styling choice with a touch caveat; on a tablet the
affordance did not exist at all.

- [x] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm run test`

In the browser: tab into a machine header, press Enter and Space and confirm
both toggle it; confirm the chevron and the chips render on a collapsed
machine; confirm the three icon buttons show a tooltip after a pause and read
correctly with `aria-label`; confirm the price pencil is visible without a
pointer by loading at 390px.

- [x] **Step 7: Commit**

```bash
git add src/components/builder
git commit -m "feat(builder): rebuild the machine card around one panel at a time

Each machine carried two sibling disclosures whose trigger buttons shared a
byte-identical class string and were told apart only by their label, with the
options one opening an inline pseudo-modal four levels deep. They become one
sub-tab strip: Options, Spec, Price, one panel visible at a time.

Global actions move out of the panels into a row beneath them. A tab should
hold what its label names, and delete does not belong a mis-click away from
the discount field. They are icons with labels and a delayed tooltip rather
than an overflow menu, because a popover would have to escape the
disclosure's overflow-hidden wrapper and because the row exists so every
action is visible without a guess.

The header was a div with an onClick, no role, no tabIndex and no key
handler, operable by keyboard only because a nested button's click bubbled.
It is a real button with aria-expanded and aria-controls, the machine name is
an h3 so the list has an outline, and noCommission gets a text badge next to
the amber wash it previously communicated with colour alone.

The price pencil was opacity-0 group-hover:opacity-100, so on a tablet the
affordance did not exist. It is always visible at 40%."
```

---

## Task 8: Autosaving options sheet

**Files:**
- Create: `src/components/builder/options-sheet.tsx`
- Delete: `src/components/builder/item-options-editor.tsx`

- [x] **Step 1: The sheet shell**

Create `options-sheet.tsx` on Base UI `Dialog`. Three regions in a fixed,
viewport-height flex column: header, scrolling list, footer.

```tsx
<Dialog.Portal>
  <Dialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/30 transition-opacity duration-(--duration-overlay) ease-(--ease-out-soft) motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
  <Dialog.Popup
    className={cn(
      "fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-white shadow-lg outline-none sm:max-w-md",
      "transition-transform duration-(--duration-overlay) ease-(--ease-out-soft) motion-reduce:transition-none",
      "data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full"
    )}
  >
    <header className="flex items-center gap-2 border-b border-line p-4">…</header>
    <div className="border-b border-line p-3">{/* search */}</div>
    <div className="min-h-0 flex-1 overflow-y-auto">{/* option rows */}</div>
    <footer className="flex items-center gap-3 border-t border-line p-4">…</footer>
  </Dialog.Popup>
</Dialog.Portal>
```

`min-h-0 flex-1` on the list is what makes the footer always reachable: a
flex child defaults to `min-height: auto` and will refuse to shrink below its
content, which pushes the footer off-screen on a long option list. The
backdrop and the popup share one duration and one easing because they move as
one thing.

This replaces an inline `max-h-[70dvh]` panel rendered inside the item card,
which had no focus trap, no Escape handling and no scroll lock, and which on
a phone was a full-screen sheet with the page still scrolling behind it.

- [x] **Step 2: Autosave the checkboxes**

Each row commits on toggle, optimistically, with revert and a toast on
failure, the pattern `terms-documents-panel.tsx` already uses for its
document tickboxes:

```tsx
function toggle(optionId: string, next: boolean) {
  setSelected((prev) => withOption(prev, optionId, next));
  startTransition(async () => {
    const result = await setItemOption(itemId, optionId, next);
    if (result && "error" in result) {
      setSelected((prev) => withOption(prev, optionId, !next));
      toast.error(result.error);
    }
  });
}
```

- [x] **Step 3: Autosave the quantity and attribute fields**

Quantity steppers and the MTS length field go through the existing
`useAutosave` hook at its 800ms default, gated exactly the way
`terms-documents-panel.tsx:58-61` gates its own:

```tsx
const state = useAutosave({
  value: draft,
  onSave: (value) => setItemOptionDetail(itemId, optionId, value),
  enabled: !readOnly && !hasError,
});
```

`enabled: !hasError` is what stops an invalid MTS length reaching the server.
The field keeps its `aria-invalid` and its hint.

- [x] **Step 4: The footer is a status strip, not a button bar**

```tsx
<footer className="flex items-center gap-3 border-t border-line p-4">
  <p className="min-w-0 flex-1 text-sm text-slate-600">
    <span className="font-medium text-brand-dark">{selected.length} selected</span>
    {" · "}
    <span className="tabular">{formatMoney(optionsSubtotalCents)}</span>
  </p>
  <AutosaveIndicator state={state} />
  <Dialog.Close render={<Button size="touch" variant="outline">Done</Button>} />
</footer>
```

Save and Cancel are gone. With every change already committed, Save would be
a lie and Cancel would be a promise the sheet cannot keep. Done only
dismisses, which is why Escape, the backdrop and the header close can all do
the same thing without the user losing anything.

- [x] **Step 5: Conflicts resolve at toggle time**

An option excluded by a current selection renders `disabled` with the reason
inline, e.g. `Unavailable: Automatic Nester V6 selected`, using the existing
option-conflict-group data. Without a Save step there is no later moment at
which to reject a selection, so it is never accepted in the first place.

- [x] **Step 6: Delete the old editor**

```bash
git rm src/components/builder/item-options-editor.tsx
rg -n 'item-options-editor' src
```
Expected: no remaining references.

- [x] **Step 7: Verify**

Run: `npm run typecheck && npm run lint && npm run test`

In the browser at 1440px and 390px:
- open the sheet on the X-Calibre machine, which has 21 options; the footer
  is visible without scrolling, at the top and at the bottom of the list
- tick an option and close the sheet immediately with Escape; reload; the
  option is still selected and the machine total has changed
- with the network throttled, tick an option and confirm the row reverts and
  a toast appears if the action fails
- tab into the sheet and confirm focus is trapped, Escape closes it, and
  focus returns to the button that opened it

- [x] **Step 8: Commit**

```bash
git add src/components/builder
git commit -m "feat(builder): move option selection into an autosaving side sheet

Options opened an inline panel with its own scroll region and sticky footer,
rendered four levels deep inside the item card, with no focus trap, no Escape
and no scroll lock, a modal in every respect except the ones that make a
modal usable. On a phone it was a full-screen sheet with the page still
scrolling behind it.

It is now a real Dialog. min-h-0 on the scrolling list is what keeps the
footer reachable: a flex child defaults to min-height auto and refuses to
shrink below its content, which is what pushed the footer off-screen on a
long option list.

Staging with Save and Cancel is gone. Every toggle commits optimistically and
reverts with a toast on failure, quantities and attributes go through the
existing autosave hook, and the hook stays disabled while a field is invalid
so a bad MTS length never reaches the server. With nothing staged, Save would
have been a lie and Cancel a promise the sheet could not keep, so the footer
became a live count and subtotal and Done only dismisses."
```

---

## Task 9: Keyboard reorder

**Files:**
- Create: `src/components/builder/use-item-reorder.ts`
- Modify: `src/components/builder/items-list.tsx`, `src/components/builder/item-card.tsx`

- [x] **Step 1: One hook, one state machine**

Move the HTML5 drag path and the pointer-event path out of
`items-list.tsx` into `use-item-reorder.ts`, and add a keyboard path to the
same state machine rather than beside it. The handle gains:

```tsx
onKeyDown={(event) => {
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    grabbed ? drop() : grab(item.id);
  } else if (grabbed && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    move(event.key === "ArrowUp" ? -1 : 1);
  } else if (event.key === "Escape" && grabbed) {
    cancel();
  }
}}
aria-pressed={grabbed}
aria-describedby={hintId}
```

with a visually hidden `<p id={hintId}>` reading "Press Space to pick up,
arrow keys to move, Space to drop, Escape to cancel." and an
`aria-live="polite"` region announcing each move as
`"${item.name}, position ${index + 1} of ${count}"`.

- [x] **Step 2: Make the arrow buttons universal**

In `item-card.tsx`, the up/down buttons lose `hidden … md:flex` (was
`items-list.tsx:434`). They were the keyboard substitute for drag, hidden
below 768px, so on a phone a keyboard user had no way to reorder at all.

- [x] **Step 3: Verify**

In the browser at 390px and 1440px: tab to a handle, press Space, press
ArrowDown, press Space, and confirm the order persisted after a reload.
Confirm the live region announces each move (check with the accessibility
tree via `read_page`).

- [x] **Step 4: Commit**

```bash
git add src/components/builder
git commit -m "feat(builder): let the keyboard reorder machines

Drag-to-reorder had a mouse path and a touch path and no keyboard path. The
up and down buttons that stood in for one were hidden below 768px, so on a
phone a keyboard user could not reorder at all.

Space picks up, arrows move, Space drops, Escape cancels, and each move is
announced. All three input paths now run through one state machine instead of
two parallel ones plus a gap."
```

---

## Task 10: States

**Files:**
- Modify: every file listed in the sweep below

- [x] **Step 1: One empty state**

Run: `rg -n '"No |>No |None' src/components/builder`

Replace each bare sentence with `<EmptyState>`: `item-options-editor`'s "No
options", `notes-section.tsx:75`'s "No notes.", `client-section.tsx:446`'s
"No contacts on file yet.", `add-item-picker.tsx:137`'s "No products in this
series.", `terms-documents-panel.tsx:189` and `:268`,
`production-forms-section.tsx:84`, and the serial-number dash.

The two existing `EmptyState` uses sit inside a bordered `SectionCard` and so
render a dashed border inside a solid one. Give `EmptyState` a
`bordered?: boolean` prop defaulting to `true`, and pass `bordered={false}`
when it is the sole child of a card.

- [x] **Step 2: One error rule**

Inline `role="alert"` under the control for anything the user can fix.
`toast.error` only for an optimistic update that had to be rolled back.
Never both for one failure. `add-custom-line-form.tsx:75-77` currently sets
`uploadError` and toasts the same thing.

- [x] **Step 3: One read-only shape**

Replace the six ad-hoc read-only renderings with `ReadOnlyValue`:
`price-display-toggles.tsx`, `delivery-terms-field.tsx`,
`validity-days-field.tsx`, `notes-section.tsx`, `terms-documents-panel.tsx`,
`client-section.tsx`.

- [x] **Step 4: Finish the label coverage**

Run: `rg -c 'htmlFor' src/components/builder/*.tsx`

`client-section.tsx` has 1, `items-list.tsx` 0, `price-display-toggles.tsx`
0, `notes-section.tsx` 0. Add `htmlFor`/`id` pairs. Where a `<label>` wraps
its input the pair is redundant and can stay as it is; where the control
relies on `aria-label` alone, prefer a real label.

- [x] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm run test`

In the browser, open `Q-AU-2026-009`, finalize nothing, but check a FINAL
quote if one exists in the seed data; otherwise finalize a copy and confirm
every read-only section renders through the same shape.

- [x] **Step 6: Commit**

```bash
git add src/components
git commit -m "refactor(builder): give empty, error and read-only one shape each

Empty was eight different bare sentences with no shared component and no
shared tone. Errors went through three parallel channels chosen per
component with no rule, and two of them fired together for the same upload
failure. Read-only was six different collapses, so a FINAL quote read as six
documents stapled together.

EmptyState also gains a bordered prop: the two places already using it sat
inside a bordered card and drew a dashed border inside a solid one."
```

---

## Task 11: Verification pass

- [x] **Step 1: Full suite**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: all pass, build completes.

- [x] **Step 2: Every screen, four widths**

At 390px, 768px, 1024px and 1440px, load and screenshot `/quotes`,
`/quotes/cmubyqmdr004cft9kg60mbmfp` on all three tabs, `/clients`,
`/catalog`, `/documents`, `/settings`, `/settings/users`, and the quotation
preview. Save each as `docs/redesign/after/<screen>-<width>.png`.

Expected: no horizontal scroll at any width; the total visible at every
width on the builder; no control under 44px on a touch width.

- [x] **Step 3: Keyboard pass**

Tab from the top of the builder to the bottom without a mouse: reach every
tab, every machine header, every sub-tab, every field, the action row's three
icon buttons, the options sheet and back out of it. Confirm focus is never
lost and never invisible.

- [x] **Step 4: Reduced motion**

In Chrome DevTools, emulate `prefers-reduced-motion: reduce`. Confirm the
disclosure, the sheet, the tooltip and the meter all change state instantly
and nothing animates.

- [x] **Step 5: Round-trip the data**

On a draft: add a machine, add three options, edit a price, set a discount,
duplicate the machine, delete the duplicate, reorder, switch to Quote terms,
change delivery weeks, switch back, reload. Confirm every change persisted
and the total matches the sum of the machine rows plus extras minus
discounts.

- [x] **Step 6: Commit the screenshots and close out**

```bash
git add docs/redesign/after
git commit -m "docs: record the redesigned builder at four widths"
```

---

## Self-review

**Spec coverage.** D1 → Task 5. D2 → Task 5 step 1. D3 → Task 5 step 2.
D4 → Tasks 4 and 6. D5 → Task 7 step 2. D6 → Task 7 step 3. D7 → Task 7
step 4. D8 → Task 8 step 1. D9 → Task 7 step 1. D10 → Task 7 (initial
`open` state derives from `quoteReadiness`). D11 → Task 7 step 5. D12 →
Task 1 steps 1 and 4, and the `motion-reduce:` variant on every transition
written in Tasks 2, 5, 6, 7 and 8. D13 → Tasks 1 to 3 ordered first.
D14 → no task; lucide stays, recorded in the spec. D15 → no task; dark mode
untouched by design. D16 → Task 8 steps 2 to 4. D17 → Task 8 step 5.
Token table → Tasks 1, 2, 3 and 10. Accessibility list → Tasks 7, 9, 10.
Component boundaries → Tasks 5 to 9. Testing → Task 4 and Task 11.

**Type consistency.** `ReadinessRow` is defined once in Task 4 and consumed
with the same field names in Tasks 5 and 6. `BuilderTab` is defined in
Task 5 step 1 and used in step 2 and in `ReadinessRow.targetTab`, where the
union is deliberately narrower (`"build" | "terms"`, since no readiness row
targets History). `parseTab` is exported from `builder-tabs.tsx` and imported
by the page in Task 5 step 3.

**Known gap.** Task 7 step 4 introduces a `duplicateItem` server action that
does not exist yet. It needs its own file,
`src/lib/actions/duplicate-item.ts`, following the shape of the existing
item actions, copying the item with its `lines` and `productionSpec` and
inserting it directly after the source in `sortOrder`. Write it as the first
sub-step of Task 7 step 4, with a unit test in `tests/` covering the sort
order it assigns, before wiring the button.
