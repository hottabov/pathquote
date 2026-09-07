# Rename the quotes section from /documents to /quotes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the quotes section from `/documents` to `/quotes` so that `/documents` is free for the new legal-documents feature.

**Architecture:** A pure route rename. Two route directories move, twenty-two references update, and the nav label changes from "Documents" to "Quotes". Nothing else changes: the Prisma `Document` model, the `[documentId]` route parameter, and every `src/lib/**/documents*` module path keep their current names, exactly as decision D9 keeps the `Series` model name while relabelling it "Category" in the UI.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, ESLint.

**Spec:** `docs/superpowers/specs/2026-09-07-quote-documentation-design.md` (decision D11).

---

## Why this is its own plan

`/documents` cannot host the new Documents section while the quotes section
still occupies it. This rename is the unblocking step, it touches no business
logic, and it ships on its own.

## File structure

**Moved wholesale (contents unchanged by the move itself):**

| From | To |
|---|---|
| `src/app/(app)/documents/` | `src/app/(app)/quotes/` |
| `src/app/api/documents/` | `src/app/api/quotes/` |

That is five page/layout files and two API route files:

```
src/app/(app)/documents/layout.tsx
src/app/(app)/documents/page.tsx
src/app/(app)/documents/[documentId]/loading.tsx
src/app/(app)/documents/[documentId]/page.tsx
src/app/(app)/documents/[documentId]/quotation/page.tsx
src/app/api/documents/[documentId]/production-forms/route.ts
src/app/api/documents/[documentId]/quotation-pdf/route.ts
```

**Edited (URL strings only):**

| File | Lines | What |
|---|---|---|
| `src/lib/nav-items.ts` | 8 | `href` and `label` |
| `src/lib/revalidate.ts` | 31, 35 | two `revalidatePath` calls |
| `src/lib/actions/documents/lifecycle.ts` | 76, 111 | two `redirect` calls |
| `src/app/(app)/page.tsx` | 25, 94, 151 | dashboard key + two links |
| `src/components/documents/production-forms-section.tsx` | 89, 113 | two API links |
| `src/app/(app)/quotes/page.tsx` (after the move) | 139, 194 | two links |
| `src/app/(app)/quotes/[documentId]/page.tsx` (after the move) | 210, 425, 430 | back href, preview link, PDF link |
| `src/app/(app)/quotes/[documentId]/quotation/page.tsx` (after the move) | 64, 78 | back href, PDF link |

**Comments mentioning the old paths** — update so they do not lie:
`src/lib/pdf.ts:2`, `src/lib/production-forms/render.ts:2`,
`src/components/sheet/quotation-sheet.tsx:22`,
`src/components/documents/production-forms-section.tsx:18`, and (after the move)
`src/app/(app)/quotes/[documentId]/quotation/page.tsx:35`.

**Deliberately NOT renamed:**

- the Prisma `Document`, `DocumentItem`, `DocumentLine` models and the
  `DocumentStatus` enum
- the `[documentId]` route segment
- `src/lib/actions/documents/`, `src/lib/queries/documents*.ts`,
  `src/lib/validation/documents.ts`, `src/components/documents/`,
  `src/lib/documents/tax.ts`
- test files and their names

A model rename is a separate, much larger change. Keeping it out means this plan
carries no migration and no data risk.

---

### Task 1: Move the route directories

**Files:**
- Move: `src/app/(app)/documents/` → `src/app/(app)/quotes/`
- Move: `src/app/api/documents/` → `src/app/api/quotes/`

- [ ] **Step 1: Confirm the starting state**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
git status --porcelain
```

Expected: no output (a clean tree). If anything is listed, stop and ask before
continuing — this plan assumes a clean starting point.

- [ ] **Step 2: Move both directories with git**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
git mv "src/app/(app)/documents" "src/app/(app)/quotes"
git mv src/app/api/documents src/app/api/quotes
```

Expected: no output. `git mv` preserves history, which a delete-and-recreate
would not.

- [ ] **Step 3: Verify the move**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
find "src/app/(app)/quotes" src/app/api/quotes -type f | sort
```

Expected exactly:

```
src/app/(app)/quotes/[documentId]/loading.tsx
src/app/(app)/quotes/[documentId]/page.tsx
src/app/(app)/quotes/[documentId]/quotation/page.tsx
src/app/(app)/quotes/layout.tsx
src/app/(app)/quotes/page.tsx
src/app/api/quotes/[documentId]/production-forms/route.ts
src/app/api/quotes/[documentId]/quotation-pdf/route.ts
```

- [ ] **Step 4: Commit the move on its own**

Committing the move separately from the edits keeps `git log --follow` able to
trace each file.

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "refactor: move the quotes routes to /quotes

Frees /documents for the legal-documents section. Directory move only;
the URLs inside these files still point at /documents and are fixed next."
```

---

### Task 2: Update the navigation item

**Files:**
- Modify: `src/lib/nav-items.ts:7-12`

- [ ] **Step 1: Edit the nav entry**

The current entry reads:

```ts
  {
    href: "/documents",
    label: "Documents",
    description: "Quotes",
    icon: FileText,
  },
```

Replace it with:

```ts
  {
    href: "/quotes",
    label: "Quotes",
    description: "Customer quotations",
    icon: FileText,
  },
```

The old `description: "Quotes"` existed to explain a label that did not say
what the section held. The label now says it, so the description carries the
sentence the dashboard card shows instead.

- [ ] **Step 2: Verify nothing else in the file references the old path**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -n "documents" src/lib/nav-items.ts
```

Expected: no output.

---

### Task 3: Update redirects and cache revalidation

**Files:**
- Modify: `src/lib/revalidate.ts:31,35`
- Modify: `src/lib/actions/documents/lifecycle.ts:76,111`

These two files decide where the app sends a user after creating or deleting a
quote, and which paths Next.js re-renders. A missed string here produces a 404
after an action succeeds — the failure is invisible until someone creates a
quote.

- [ ] **Step 1: Update `revalidate.ts`**

Line 31 currently reads `revalidatePath("/documents");` — change to:

```ts
  revalidatePath("/quotes");
```

Line 35 currently reads ``revalidatePath(`/documents/${documentId}`);`` — change to:

```ts
  revalidatePath(`/quotes/${documentId}`);
```

- [ ] **Step 2: Update `lifecycle.ts`**

Line 76 currently reads ``redirect(`/documents/${created.id}`);`` — change to:

```ts
  redirect(`/quotes/${created.id}`);
```

Line 111 currently reads `redirect("/documents");` — change to:

```ts
  redirect("/quotes");
```

- [ ] **Step 3: Verify both files**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -n '"/quotes\|`/quotes' src/lib/revalidate.ts src/lib/actions/documents/lifecycle.ts
```

Expected: four lines, one per edit above.

---

### Task 4: Update the dashboard

**Files:**
- Modify: `src/app/(app)/page.tsx:25,94,151`

- [ ] **Step 1: Read the surrounding context first**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
sed -n '18,32p;90,98p;146,156p' "src/app/(app)/page.tsx"
```

Line 25 is a key in a lookup object mapping a nav href to something else. Read
what the object is before editing: the **key** is an href and must become
`"/quotes"`, but its **value** may be a data field name that has nothing to do
with routing and must not be touched.

- [ ] **Step 2: Make the three edits**

- line 25: the object key `"/documents"` becomes `"/quotes"`. Leave the value
  exactly as it is.
- line 94: `href="/documents"` becomes `href="/quotes"`
- line 151: ``href={`/documents/${document.id}`}`` becomes
  ``href={`/quotes/${document.id}`}``

- [ ] **Step 3: Verify**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -n '/documents' "src/app/(app)/page.tsx"
```

Expected: no output.

---

### Task 5: Update the production-forms links

**Files:**
- Modify: `src/components/documents/production-forms-section.tsx:18,89,113`

- [ ] **Step 1: Update the two API links**

Line 89 currently reads:

```tsx
              <Link href={`/api/documents/${document.id}/production-forms?item=${ctx.item.id}`} className={pdfLinkClass}>
```

becomes:

```tsx
              <Link href={`/api/quotes/${document.id}/production-forms?item=${ctx.item.id}`} className={pdfLinkClass}>
```

Line 113 currently reads:

```tsx
        <Link href={`/api/documents/${document.id}/production-forms`} className={downloadAllClass}>
```

becomes:

```tsx
        <Link href={`/api/quotes/${document.id}/production-forms`} className={downloadAllClass}>
```

- [ ] **Step 2: Update the comment on line 18**

It reads `exactly the check `/api/documents/[documentId]/production-forms` makes —`.
Change `/api/documents/` to `/api/quotes/` so the comment points at a route
that exists.

- [ ] **Step 3: Verify**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -n '/documents' src/components/documents/production-forms-section.tsx
```

Expected: no output. (The file's own path still contains `documents/` — that is
the module path, deliberately unchanged.)

---

### Task 6: Update the moved quote pages

**Files:**
- Modify: `src/app/(app)/quotes/page.tsx:139,194`
- Modify: `src/app/(app)/quotes/[documentId]/page.tsx:210,425,430`
- Modify: `src/app/(app)/quotes/[documentId]/quotation/page.tsx:35,64,78`

- [ ] **Step 1: `quotes/page.tsx`**

Line 139: ``const href = `/documents/${d.id}`;`` becomes

```ts
  const href = `/quotes/${d.id}`;
```

Line 194: ``href={`/documents/${d.id}`}`` becomes ``href={`/quotes/${d.id}`}``

- [ ] **Step 2: `quotes/[documentId]/page.tsx`**

Line 210: `backHref="/documents"` becomes `backHref="/quotes"`. The visible
`backLabel` on this `PageHeader` — check whether one is passed and whether it
says "Documents"; if so it becomes "Quotes".

Line 425: ``href={`/documents/${document.id}/quotation`}`` becomes
``href={`/quotes/${document.id}/quotation`}``

Line 430: ``href={`/api/documents/${document.id}/quotation-pdf`}`` becomes
``href={`/api/quotes/${document.id}/quotation-pdf`}``

- [ ] **Step 3: `quotes/[documentId]/quotation/page.tsx`**

Line 35 (comment): `/api/documents/` becomes `/api/quotes/`

Line 64: ``href={`/documents/${document.id}`}`` becomes
``href={`/quotes/${document.id}`}``

Line 78: ``href={`/api/documents/${document.id}/quotation-pdf`}`` becomes
``href={`/api/quotes/${document.id}/quotation-pdf`}``

- [ ] **Step 4: Verify all three**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -rn '/documents' "src/app/(app)/quotes"
```

Expected: no output.

---

### Task 7: Update the remaining stale comments

**Files:**
- Modify: `src/lib/pdf.ts:2`
- Modify: `src/lib/production-forms/render.ts:2`
- Modify: `src/components/sheet/quotation-sheet.tsx:22`

- [ ] **Step 1: Replace the three path references**

- `src/lib/pdf.ts:2` — `src/app/api/documents/[documentId]/quotation-pdf/route.ts`
  becomes `src/app/api/quotes/[documentId]/quotation-pdf/route.ts`
- `src/lib/production-forms/render.ts:2` —
  `src/app/api/documents/[documentId]/production-forms/route.ts` becomes
  `src/app/api/quotes/[documentId]/production-forms/route.ts`
- `src/components/sheet/quotation-sheet.tsx:22` —
  `` `/documents/[documentId]/quotation` `` becomes
  `` `/quotes/[documentId]/quotation` ``

---

### Task 8: Verify the whole rename and commit

- [ ] **Step 1: Prove no quote URL still says /documents**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -rn '"/documents\|`/documents\|/api/documents' src --include=*.ts --include=*.tsx
```

Expected: no output. Any hit is a missed link.

- [ ] **Step 2: Confirm the module paths were left alone**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -rln 'lib/actions/documents\|lib/queries/documents' src --include=*.ts --include=*.tsx | wc -l
```

Expected: a non-zero count. These are TypeScript import paths, not URLs, and
must not have been rewritten. If this prints `0`, a search-and-replace went too
wide — revert and redo the edits by hand.

- [ ] **Step 3: Typecheck**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck
```

Expected: exits 0 with no errors. Next.js generates route types from the
directory tree, so a missed route reference surfaces here.

- [ ] **Step 4: Lint**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run lint
```

Expected: exits 0.

- [ ] **Step 5: Run the test suite**

Run:

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm test
```

Expected: all tests pass. The suite is pure unit tests with no routing
assertions, so this is a regression check rather than a check of the rename
itself.

- [ ] **Step 6: Check the pages actually load**

Start the dev server and open the three routes by hand:

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run dev
```

Then visit, signed in:

1. `http://localhost:3100/` — the dashboard. The nav shows **Quotes**, and its
   card and recent-quote links go to `/quotes/...`.
2. `http://localhost:3100/quotes` — the quotes list renders and a row opens the
   builder.
3. `http://localhost:3100/quotes/<id>/quotation` — the preview renders, its back
   link returns to the builder, and the PDF link resolves to
   `/api/quotes/<id>/quotation-pdf`.

Also confirm `http://localhost:3100/documents` now 404s. It should — the next
plan gives that URL to the new section.

- [ ] **Step 7: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "refactor: point every quote link at /quotes

Completes the directory move: nav item, redirects, revalidatePath calls,
dashboard, production-form links and the moved pages' own links. The
Prisma Document model, the [documentId] segment and the
src/lib/**/documents* module paths keep their names, the way Series keeps
its name while the UI calls it Category."
```

---

## Self-review notes

**Spec coverage.** This plan implements D11 only. Every other decision in the
spec belongs to the two plans that follow.

**Not covered here, by design:** the `QuoteDocument` model, the Documents
section UI, category copy in the catalog, term values, the snapshot freeze, and
removing `ContentBlock`.

**Risk.** The one way to get this wrong is an over-broad search-and-replace that
rewrites `@/lib/actions/documents/...` import paths along with the URLs. Task 8
Step 2 exists to catch exactly that, and every edit above names its line rather
than offering a `sed` command.
