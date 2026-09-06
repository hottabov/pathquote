# Production Order Forms Implementation Plan

> **Superseded, 2026-09-04 — production lines.** Everything below describing
> `DocumentItem.lineGroup`, the Line selector, and the automatic propagation of
> the operator screen side across a line is history. The owner found machines
> in one line that legitimately face opposite ways (a cutter's screen on one
> side, the conveyor and FabricPro controls on the other), so lines were
> dropped entirely (migration `z29_drop_line_group`) and the side is now
> *offered* to the rest of the quote rather than applied to it — see
> `applyScreenSideToQuote`.
>
> **Superseded — the EasyLoader.** Its table-length options are no longer
> picked by hand and reconciled against the drawn sections. The layout is the
> input and the options are computed from it (`deriveEasyLoaderOptions`), so
> the reconciliation gate this plan describes is gone: the mismatch it caught
> can no longer be expressed. The machine itself now prices at 0, since every
> part of it is an option.
>
> **Superseded, 2026-09-06 — codes are labels.** The specs below read facts
> out of the product code (`/^EL-\d{4}$/`, the printed-width map keyed by
> code, `/^M(3|5|7|10)…$/`, option codes assembled as `${itemCode} ${suffix}`).
> All of that is gone: forms now read `Product.form/specs` and `Option.role`
> (`docs/plans/2026-09-05-catalog-identity-and-cleanup.md`). The code
> listings that follow are the record of the first implementation, not the
> current one.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the Pathfinder workshop order forms (M-Series, EasyLoader, FabricPro) from a finalized quote as one print-ready PDF, one A4 page per form, with every derivable box already ticked.

**Architecture:** The original `.xlsx` order forms become committed templates. For each machine item in the quote we patch cells in a copy of its template — inline strings only, one zip entry touched — and convert it through the existing Gotenberg container's LibreOffice route, then merge the pages with Gotenberg's PDF-engines route. A declarative `FormSpec` per form holds every cell coordinate, so adding a form is one file plus one template. Sales-side choices the price list does not carry (screen side, knife size, voltage, drills) live in a new `DocumentItem.productionSpec` JSON column.

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma 7 + PostgreSQL, Zod 4, Vitest, Gotenberg 8 (Chromium + LibreOffice + PDF engines), `fflate` for zip.

**Spec:** `docs/specs/2026-09-01-production-order-forms-design.md`

---

## Read this first

**Task 0 was the gate and it has passed** (2026-09-01). The xlsx-template approach is confirmed: LibreOffice renders a patched template as one faithful A4 page. Task 0 now records that result and the three coordinate bugs it caught; read it, then start at Task 1.

**Codebase conventions you must follow** (they are already established; do not invent new ones):

- Zod schemas live in `src/lib/validation/<domain>.ts` and are unit-tested in `tests/<domain>-validation.test.ts`.
- Server actions live in `src/lib/actions/<domain>.ts`, start with `"use server"`, call `requireSession()`, validate every argument with `safeParse`, return `ActionResult` (`{ error?: string; warning?: string }`), and finish with `revalidatePath`.
- Read queries live in `src/lib/queries/<domain>.ts` and are scoped to the caller with the helpers in `src/lib/scope.ts`.
- Migrations are hand-written SQL in `prisma/migrations/<n>_<name>/migration.sql`, numbered sequentially, and open with a comment explaining *why* the change exists — read `prisma/migrations/8_company_delivery_address/migration.sql` for the house style before writing yours.
- Tests are Vitest, in `tests/*.test.ts`, importing source as `../src/lib/...`.
- Run tests with `npm test`, types with `npm run typecheck`, lint with `npm run lint`.

**Database access during development:** `docker compose up -d postgres gotenberg` then `npm run db:migrate`. Gotenberg must be running for tasks 9 and 14 onward; `GOTENBERG_URL=http://localhost:3001` is already in `.env`.

---

## File structure

**New — data and validation**

| File | Responsibility |
|---|---|
| `prisma/migrations/10_industry_and_production_spec/migration.sql` | `Industry` table, `Company.industryId`, `DocumentItem.productionSpec` + `lineGroup` |
| `src/lib/validation/industries.ts` | `industryNameSchema` |
| `src/lib/validation/production-spec.ts` | Per-series `productionSpec` schemas, `requiredKeysFor`, `missingKeys` |
| `src/lib/queries/industries.ts` | `listIndustries`, `countCompaniesUsingIndustry` |
| `src/lib/actions/industries.ts` | `createIndustry`, `renameIndustry`, `setCompanyIndustry` |
| `src/lib/actions/production.ts` | `setProductionSpec`, `setItemLineGroup` |

**New — form engine.** Split by responsibility, not by layer: each file is independently testable and holds one idea.

| File | Responsibility |
|---|---|
| `src/lib/production-forms/cell-ref.ts` | `columnIndex`, `splitRef` — pure address arithmetic |
| `src/lib/production-forms/xlsx-patch.ts` | `patchSheetXml`, `patchWorkbook` — the only code that touches xlsx bytes |
| `src/lib/production-forms/types.ts` | `FormSpec`, `FormContext`, `FormItem` |
| `src/lib/production-forms/context.ts` | `buildFormContext` — Prisma document → plain context |
| `src/lib/production-forms/resolve.ts` | `resolveForm`, `planForms`, `missingRequirements`, `additionalItems` |
| `src/lib/production-forms/specs/m-series.ts` | M-Series cell map |
| `src/lib/production-forms/specs/easyloader.ts` | EasyLoader cell map |
| `src/lib/production-forms/specs/fabricpro.ts` | FabricPro cell map |
| `src/lib/production-forms/specs/index.ts` | `FORM_SPECS` registry |
| `src/lib/production-forms/render.ts` | `xlsxToPdf`, `mergePdfs` — Gotenberg calls |
| `src/lib/production-forms/templates/*.xlsx` | Committed template binaries |

**New — UI and route**

| File | Responsibility |
|---|---|
| `src/components/clients/industry-picker.tsx` | Typeahead combobox with create + rename |
| `src/components/builder/production-spec-editor.tsx` | Per-item production fields + line chip |
| `src/components/documents/production-forms-section.tsx` | Readiness list + download buttons |
| `src/components/sheet/additional-items-sheet.tsx` | The "Additional items" page |
| `src/app/api/documents/[documentId]/production-forms/route.ts` | Merged PDF, `?item=` for one form |
| `scripts/import-industries.ts` | Bulk import |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | New model + three columns |
| `src/components/clients/company-form.tsx` | Mount `IndustryPicker` |
| `src/components/builder/items-list.tsx` | Mount `ProductionSpecEditor` in each machine card |
| `src/app/(app)/documents/[documentId]/page.tsx` | Mount `ProductionFormsSection` |
| `package.json` | Add `fflate` |

---

## Task 0: Spike — LibreOffice fidelity — **PASSED 2026-09-01, no work required**

This gate has already been run and cleared. It is recorded here so the result and its consequences are not lost.

**What was done:** `M-series order 12.xlsx` was patched with a full set of `X` marks and header values by a throwaway script and converted with headless LibreOffice — the same engine Gotenberg's `/forms/libreoffice/convert` route wraps.

**Result:** exactly one A4 page (595.3 × 841.9 pt), every `X` inside its intended box, logos, frames, print area and scaling intact. Century Gothic was substituted by the container's default sans, which the repo owner accepted. **Approach A stands. Approach B is not needed.**

**Three coordinate bugs it caught**, already corrected in the tasks below and in spec §5.1 — do not "fix" them back:

1. Writing the author name into `M8` clipped the `Name:` label to "Nam". The label lives in `L8`, which is 4.3 characters wide and depends on overflowing rightwards. The name belongs in `N8`.
2. `E81` does not exist in the sheet XML at all — Excel omits empty cells, so the patcher's cell-insert path is load-bearing, not theoretical. Drills moved to `H81` (Yes/No) and `J82` (detail).
3. Rows 81–82 carry a large hand-writing font and their two columns collide. Hence the caps: drill detail 22 characters, special notes 28 characters, notes on one line only.

**The generalisable lesson for every remaining form spec:** a cell that looks blank beside a label may be the cell that label overflows into, and a "free area" is only as wide as the next occupied cell. Neither is visible in the spreadsheet, and neither is catchable by the contract test in Task 15. **Every new form spec gets one page printed and checked by eye before it ships.**

- [ ] **Step 1: Read this task, change nothing, move to Task 1**

If you want to reproduce the render yourself before trusting it:

```bash
docker compose up -d gotenberg
curl -sS --request POST http://localhost:3001/forms/libreoffice/convert \
  --form files=@"RAW/Order Forms/M-series order 12.xlsx" -o /tmp/blank-form.pdf
pdfinfo /tmp/blank-form.pdf | grep Pages
```

Expected: `Pages: 1`. That confirms the container converts the template to a single A4 page before any patching is involved.

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/10_industry_and_production_spec/migration.sql`

- [ ] **Step 1: Add the model and columns to the schema**

In `prisma/schema.prisma`, add a new model after `Contact`:

```prisma
// Lookup table rather than free text on Company: the list is bulk-imported
// (scripts/import-industries.ts) and picked hundreds of times, so an
// industry has to be one row every company points at instead of a string
// repeated with drifting spellings -- that is what makes the inline rename
// in industry-picker.tsx a real fix rather than a per-company patch.
// Global, not per-region: an industry means the same thing in AU and US.
model Industry {
  id        String    @id @default(cuid())
  name      String    @unique
  createdAt DateTime  @default(now())
  companies Company[]
}
```

In `model Company`, add beside the other optional fields:

```prisma
  industryId String?
  industry   Industry? @relation(fields: [industryId], references: [id], onDelete: SetNull)
```

and add `@@index([industryId])` next to the existing `@@index([ownerId])`.

In `model DocumentItem`, add after `showImage`:

```prisma
  // Sales-side production choices the price list does not carry: screen side
  // (+Y/-Y), knife size, voltage, drills, EasyLoader table sections. Shape
  // varies by series -- validated by src/lib/validation/production-spec.ts,
  // never read as free-form JSON. Deliberately NOT covered by the finalize
  // lock: it carries no commercial meaning, so correcting a knife size must
  // not force an unfinalize/refinalize cycle that churns document numbering.
  productionSpec Json?
  // Production line grouping. Items sharing a value share an operator-screen
  // side -- a cutter, its EasyLoader and its FabricPro stand together and a
  // mismatched side is a physical installation fault. Defaults to 1 so the
  // single-line case never sees the field. See spec section 4.2 for why this
  // is an Int rather than a ProductionLine table.
  lineGroup      Int  @default(1)
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/10_industry_and_production_spec/migration.sql`:

```sql
-- Production order forms (docs/specs/2026-09-01-production-order-forms-design.md).
--
-- Industry becomes a lookup table because the list is bulk-imported and
-- shared: one row per industry that every company references, so fixing an
-- imported typo fixes it everywhere. ON DELETE SET NULL so removing an
-- industry never blocks and never cascades into companies.
--
-- DocumentItem gains the two fields the order forms need but the price list
-- has no reason to carry: productionSpec (screen side, knife size, voltage,
-- drills, table sections) and lineGroup, which keeps the operator-screen
-- side consistent across a cutter and its spreaders. lineGroup defaults to 1
-- so every existing item reads as "the only line" with no data migration.
CREATE TABLE "Industry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Industry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Industry_name_key" ON "Industry"("name");

ALTER TABLE "Company" ADD COLUMN "industryId" TEXT;

CREATE INDEX "Company_industryId_idx" ON "Company"("industryId");

ALTER TABLE "Company" ADD CONSTRAINT "Company_industryId_fkey"
    FOREIGN KEY ("industryId") REFERENCES "Industry"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DocumentItem" ADD COLUMN "productionSpec" JSONB,
ADD COLUMN "lineGroup" INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 3: Apply and verify**

```bash
docker compose up -d postgres
npm run db:migrate
npx prisma generate
npm run typecheck
```

Expected: migration applies, `typecheck` passes.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/10_industry_and_production_spec
git commit -m "feat: industry lookup table, production spec and line group on items"
```

---

## Task 2: Industry validation schema

**Files:**
- Create: `src/lib/validation/industries.ts`
- Test: `tests/industries-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/industries-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { industryNameSchema, normalizeIndustryName } from "../src/lib/validation/industries";

describe("industryNameSchema", () => {
  it("accepts a normal name", () => {
    expect(industryNameSchema.safeParse("Automotive").success).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = industryNameSchema.safeParse("  Marine upholstery  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Marine upholstery");
  });

  it("rejects an empty string", () => {
    expect(industryNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects whitespace only", () => {
    expect(industryNameSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects a name longer than 80 characters", () => {
    expect(industryNameSchema.safeParse("x".repeat(81)).success).toBe(false);
  });
});

describe("normalizeIndustryName", () => {
  it("lowercases for comparison", () => {
    expect(normalizeIndustryName("Automotive")).toBe("automotive");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeIndustryName("Marine   upholstery")).toBe("marine upholstery");
  });

  it("treats differently cased spellings as the same key", () => {
    expect(normalizeIndustryName("AUTOMOTIVE")).toBe(normalizeIndustryName("automotive"));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/industries-validation.test.ts`
Expected: FAIL — cannot resolve `../src/lib/validation/industries`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/validation/industries.ts`:

```ts
import { z } from "zod";

/**
 * An industry name as typed by a user. 80 characters is generous for the
 * imported list and keeps the value inside the `Industry:` cell on every
 * order form without overflow.
 */
export const industryNameSchema = z
  .string()
  .trim()
  .min(1, "Industry name is required")
  .max(80, "Industry name must be 80 characters or fewer");

/**
 * Comparison key for deduplication. Creating "automotive" when "Automotive"
 * already exists must select the existing row rather than add a near-
 * duplicate to a list people scroll through -- see `createIndustry`.
 */
export function normalizeIndustryName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/industries-validation.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/industries.ts tests/industries-validation.test.ts
git commit -m "feat: industry name validation and dedup key"
```

---

## Task 3: Industry queries and actions

**Files:**
- Create: `src/lib/queries/industries.ts`
- Create: `src/lib/actions/industries.ts`

Read `src/lib/actions/clients.ts` first — copy its `requireSession` / `safeParse` / `ActionResult` / `revalidatePath` shape exactly.

- [ ] **Step 1: Write the queries**

Create `src/lib/queries/industries.ts`:

```ts
import { db } from "@/lib/db";

/**
 * Every industry, alphabetically. The picker filters client-side: the list
 * is expected to hold hundreds of imported rows, which is small enough to
 * ship whole and makes typeahead instant with no round trip per keystroke.
 */
export async function listIndustries() {
  return db.industry.findMany({ orderBy: { name: "asc" } });
}

/**
 * How many companies point at an industry. Shown in the rename confirmation
 * so a shared-row edit is never silent.
 */
export async function countCompaniesUsingIndustry(industryId: string): Promise<number> {
  return db.company.count({ where: { industryId } });
}
```

- [ ] **Step 2: Write the actions**

Create `src/lib/actions/industries.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { companyWhereForUser } from "@/lib/scope";
import { idSchema, optionalIdSchema } from "@/lib/validation/documents";
import { industryNameSchema, normalizeIndustryName } from "@/lib/validation/industries";

export type ActionResult = { error?: string };

const NOT_FOUND_ERROR = "Not found";

/** Join every zod issue message (form-level + field-level) into one string
 * for a plain `{ error }` result — same helper as actions/clients.ts, kept
 * local here for the same reason: one tiny function is not worth a
 * dependency between two action modules. */
function flattenZodError(error: z.ZodError): string {
  const flat = error.flatten();
  const messages = [...flat.formErrors, ...Object.values(flat.fieldErrors).flat()].filter(
    (m): m is string => Boolean(m)
  );
  return messages.length > 0 ? messages.join(" ") : "Invalid input";
}

/**
 * Finds an industry by case-insensitive name, or null.
 *
 * Prisma cannot express `WHERE LOWER(name) = $1` against the functional index
 * the migration creates, and `mode: "insensitive"` would not use it either.
 * The table holds hundreds of rows at most, so reading them and comparing in
 * JS is both correct and cheap.
 */
async function findByNormalizedName(name: string) {
  const key = normalizeIndustryName(name);
  return (await db.industry.findMany()).find((row) => normalizeIndustryName(row.name) === key) ?? null;
}

/**
 * Creates an industry, or returns the existing one when a case-insensitive
 * match is already present -- typing "automotive" next to an existing
 * "Automotive" must not grow the list by a near-duplicate.
 *
 * The pre-check alone is check-then-act and races: two people typing the same
 * industry into the picker at the same moment would both pass it. The
 * `Industry_name_lower_key` functional index in the migration is the real
 * guarantee, so a unique violation here is an expected outcome, not an error
 * -- it means someone else won, and their row is the answer.
 */
export async function createIndustry(name: string): Promise<ActionResult & { id?: string }> {
  await requireSession();

  const parsed = industryNameSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const existing = await findByNormalizedName(parsed.data);
  if (existing) return { id: existing.id };

  try {
    const created = await db.industry.create({ data: { name: parsed.data } });
    revalidatePath("/clients");
    return { id: created.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await findByNormalizedName(parsed.data);
      if (winner) return { id: winner.id };
    }
    throw error;
  }
}

/**
 * Renames the shared row. The caller shows the affected-company count first
 * (see `countCompaniesUsingIndustry`); this only guards the data.
 */
// Admin-only, unlike createIndustry: creating is additive and deduplicated,
// but renaming changes a value every manager's companies display and every
// production form prints. Same rule as the other global tables.
export async function renameIndustry(industryId: string, name: string): Promise<ActionResult> {
  await requireAdmin();

  const parsedId = idSchema.safeParse(industryId);
  if (!parsedId.success) return { error: NOT_FOUND_ERROR };

  const parsed = industryNameSchema.safeParse(name);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const industry = await db.industry.findUnique({ where: { id: parsedId.data } });
  if (!industry) return { error: NOT_FOUND_ERROR };

  const clash = await findByNormalizedName(parsed.data);
  if (clash && clash.id !== industry.id) return { error: `"${clash.name}" already exists` };

  try {
    await db.industry.update({ where: { id: industry.id }, data: { name: parsed.data } });
  } catch (error) {
    // Same race as createIndustry: another rename could have taken this name
    // between the check above and the write. Report it as the collision it is
    // rather than surfacing a raw database error.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `"${parsed.data}" already exists` };
    }
    throw error;
  }

  revalidatePath("/clients");
  return {};
}

/**
 * Points a company at an industry, or clears it. Scoped like every other
 * company mutation in src/lib/actions/clients.ts.
 */
export async function setCompanyIndustry(
  companyId: string,
  industryId: string | null,
): Promise<ActionResult> {
  const session = await requireSession();

  const parsedCompanyId = idSchema.safeParse(companyId);
  if (!parsedCompanyId.success) return { error: NOT_FOUND_ERROR };

  const parsedIndustryId = optionalIdSchema.safeParse(industryId ?? undefined);
  if (!parsedIndustryId.success) return { error: NOT_FOUND_ERROR };

  const company = await db.company.findFirst({
    where: { id: parsedCompanyId.data, ...companyWhereForUser(session.user) },
  });
  if (!company) return { error: NOT_FOUND_ERROR };

  await db.company.update({
    where: { id: company.id },
    data: { industryId: parsedIndustryId.data ?? null },
  });

  revalidatePath(`/clients/${company.id}`);
  return {};
}
```

Note on the local helpers: every action module in this repo declares its own `ActionResult` and its own `flattenZodError`, each with a comment saying the duplication is deliberate rather than accidental. That is the established pattern — follow it. Do **not** try to import `flattenZodError` from `src/lib/actions/documents.ts`: it is not exported, and it cannot be, because a `"use server"` module may only export async server actions.

`companyWhereForUser` and `requireSession` do already exist and are shared — import them from `@/lib/scope` and `@/lib/authz` as shown.

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: PASS. Fix any import path that does not match what `clients.ts` actually exports.

- [ ] **Step 4: Commit**

```bash
git add src/lib/queries/industries.ts src/lib/actions/industries.ts
git commit -m "feat: industry queries and create/rename/assign actions"
```

---

## Task 4: Industry picker component

**Files:**
- Create: `src/components/clients/industry-picker.tsx`
- Modify: `src/components/clients/company-form.tsx`

- [ ] **Step 1: Write the picker**

Create `src/components/clients/industry-picker.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { createIndustry, renameIndustry, setCompanyIndustry } from "@/lib/actions/industries";
import { normalizeIndustryName } from "@/lib/validation/industries";

type Industry = { id: string; name: string };

type Props = {
  companyId: string;
  industries: Industry[];
  selectedId: string | null;
  /** Companies using the currently selected industry, for the rename confirm. */
  usageCount: number;
  /**
   * Whether to offer the rename pencil. Renaming is admin-only (see
   * `renameIndustry`): the row is shared, so the edit lands on every
   * manager's companies. Creating and selecting stay open to everyone.
   */
  canRename: boolean;
};

export function IndustryPicker({ companyId, industries, selectedId, usageCount, canRename }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = industries.find((i) => i.id === selectedId) ?? null;

  const matches = useMemo(() => {
    const key = normalizeIndustryName(query);
    if (!key) return industries;
    return industries.filter((i) => normalizeIndustryName(i.name).includes(key));
  }, [industries, query]);

  const exactMatch = matches.some((i) => normalizeIndustryName(i.name) === normalizeIndustryName(query));
  const canCreate = query.trim().length > 0 && !exactMatch;

  async function choose(industryId: string | null) {
    setPending(true);
    setError(null);
    const result = await setCompanyIndustry(companyId, industryId);
    setPending(false);
    if (result.error) setError(result.error);
    else {
      setOpen(false);
      setQuery("");
    }
  }

  async function create() {
    setPending(true);
    setError(null);
    const result = await createIndustry(query);
    setPending(false);
    if (result.error) setError(result.error);
    else if (result.id) await choose(result.id);
  }

  async function rename() {
    if (!selected) return;
    const next = window.prompt(
      `Rename "${selected.name}"? Used by ${usageCount} ${usageCount === 1 ? "company" : "companies"}.`,
      selected.name,
    );
    if (next === null || next === selected.name) return;
    setPending(true);
    setError(null);
    const result = await renameIndustry(selected.id, next);
    setPending(false);
    if (result.error) setError(result.error);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={open ? query : (selected?.name ?? "")}
          placeholder="Search or add an industry"
          disabled={pending}
          onFocus={() => setOpen(true)}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border px-2 py-1"
          aria-label="Industry"
        />
        {selected && !open && canRename && (
          <button type="button" onClick={rename} disabled={pending} aria-label="Rename industry">
            ✎
          </button>
        )}
      </div>

      {open && (
        <ul className="max-h-56 overflow-auto rounded border">
          {selected && (
            <li>
              <button type="button" onClick={() => choose(null)} className="w-full px-2 py-1 text-left">
                Clear
              </button>
            </li>
          )}
          {matches.map((industry) => (
            <li key={industry.id}>
              <button
                type="button"
                onClick={() => choose(industry.id)}
                className="w-full px-2 py-1 text-left"
              >
                {industry.name}
              </button>
            </li>
          ))}
          {canCreate && (
            <li>
              <button type="button" onClick={create} className="w-full px-2 py-1 text-left font-medium">
                Create &ldquo;{query.trim()}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the company form**

In `src/components/clients/company-form.tsx`, extend the props and add a field row beside the other company fields, using the existing `FieldRow` from `@/components/ui-kit`:

```tsx
import { IndustryPicker } from "@/components/clients/industry-picker";

// added to the component's Props
type Props = {
  // ...existing props
  industries: Array<{ id: string; name: string }>;
  industryUsageCount: number;
};

// rendered among the existing field rows
<FieldRow label="Industry">
  <IndustryPicker
    companyId={company.id}
    industries={industries}
    selectedId={company.industryId}
    usageCount={industryUsageCount}
  />
</FieldRow>
```

In the server component that renders the form (`src/app/(app)/clients/[companyId]/page.tsx`), load and pass them:

```tsx
const industries = await listIndustries();
const industryUsageCount = company.industryId
  ? await countCompaniesUsingIndustry(company.industryId)
  : 0;
```

The picker writes through its own action rather than the surrounding form, so it only works on a saved company. On the "new client" screen (`src/app/(app)/clients/new/page.tsx`) do not render it — industry is set once the company exists.

- [ ] **Step 3: Verify manually**

```bash
npm run dev
```

Open a client card. Confirm: typing filters; a non-matching query offers `Create "…"`; creating selects it; the pencil renames with the company count in the prompt; `Clear` empties the field.

- [ ] **Step 4: Commit**

```bash
git add src/components/clients/industry-picker.tsx src/components/clients/company-form.tsx
git commit -m "feat: industry picker with typeahead, inline create and rename"
```

---

## Task 5: Industry bulk import script

**Files:**
- Create: `scripts/import-industries.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Create `scripts/import-industries.ts`:

```ts
/**
 * Bulk-imports industries from a newline-separated file. Upserts by
 * normalized name so re-running is safe and never creates a near-duplicate
 * of a row a user already added by hand through the picker.
 *
 * Usage: npx tsx scripts/import-industries.ts industries.txt
 */
import { readFileSync } from "node:fs";
import { industryNameSchema, normalizeIndustryName } from "../src/lib/validation/industries";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/import-industries.ts <file>");
    process.exit(1);
  }

  // Imported here, not at module scope. Prisma 7 in this project needs an
  // explicit driver adapter (see src/lib/db.ts); a bare `new PrismaClient()`
  // throws at module load, before the usage check above can run. Same lazy
  // import that scripts/create-user.ts and scripts/import-product-images.ts
  // use.
  const { db } = await import("../src/lib/db");

  const existing = await db.industry.findMany();
  const seen = new Map(existing.map((row) => [normalizeIndustryName(row.name), row.name]));

  let created = 0;
  let skipped = 0;
  let invalid = 0;

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;

    const parsed = industryNameSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`skipping invalid name: ${JSON.stringify(raw)}`);
      invalid += 1;
      continue;
    }

    const key = normalizeIndustryName(parsed.data);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }

    await db.industry.create({ data: { name: parsed.data } });
    seen.set(key, parsed.data);
    created += 1;
  }

  console.log(`created ${created}, already present ${skipped}, invalid ${invalid}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => process.exit(0));
```

- [ ] **Step 2: Add the npm script**

In `package.json`, beside the other `scripts` entries:

```json
"import:industries": "tsx scripts/import-industries.ts",
```

- [ ] **Step 3: Verify**

```bash
printf 'Automotive\nMarine upholstery\nautomotive\n\n' > /tmp/industries.txt
npm run import:industries /tmp/industries.txt
npm run import:industries /tmp/industries.txt
```

Expected: first run reports `created 2`; second reports `created 0, already present 2`. The lowercase `automotive` is deduplicated against `Automotive` on the first run.

- [ ] **Step 4: Commit**

```bash
git add scripts/import-industries.ts package.json
git commit -m "feat: bulk industry import script, upsert by normalized name"
```

---

## Task 6: Production spec validation

**Files:**
- Create: `src/lib/validation/production-spec.ts`
- Test: `tests/production-spec-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/production-spec-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  mSeriesSpecSchema,
  easyLoaderSpecSchema,
  fabricProSpecSchema,
  missingKeys,
} from "../src/lib/validation/production-spec";

const validMSeries = {
  ui: "+Y",
  knifeSize: "1.5x5.0",
  drills: { required: true, detail: "2 x 6mm" },
};

describe("mSeriesSpecSchema", () => {
  it("accepts a complete spec", () => {
    expect(mSeriesSpecSchema.safeParse(validMSeries).success).toBe(true);
  });

  it("rejects an unknown screen side", () => {
    expect(mSeriesSpecSchema.safeParse({ ...validMSeries, ui: "+X" }).success).toBe(false);
  });

  it("rejects an unknown knife size", () => {
    expect(mSeriesSpecSchema.safeParse({ ...validMSeries, knifeSize: "9x9" }).success).toBe(false);
  });

  it("accepts drills declared as not required with no detail", () => {
    const result = mSeriesSpecSchema.safeParse({
      ...validMSeries,
      drills: { required: false, detail: "" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects drills required with an empty detail", () => {
    const result = mSeriesSpecSchema.safeParse({
      ...validMSeries,
      drills: { required: true, detail: "   " },
    });
    expect(result.success).toBe(false);
  });

  it("caps special notes at the width measured in the spike", () => {
    expect(mSeriesSpecSchema.safeParse({ ...validMSeries, specialNotes: "x".repeat(28) }).success).toBe(true);
    expect(mSeriesSpecSchema.safeParse({ ...validMSeries, specialNotes: "x".repeat(29) }).success).toBe(false);
  });

  it("caps the drill detail at the width measured in the spike", () => {
    const detail = (length: number) => ({
      ...validMSeries,
      drills: { required: true, detail: "x".repeat(length) },
    });
    expect(mSeriesSpecSchema.safeParse(detail(22)).success).toBe(true);
    expect(mSeriesSpecSchema.safeParse(detail(23)).success).toBe(false);
  });
});

describe("easyLoaderSpecSchema", () => {
  it("accepts up to three table sections", () => {
    const result = easyLoaderSpecSchema.safeParse({
      ui: "-Y",
      usage: "onload",
      sections: [
        { lengthM: 2.4, surface: "static" },
        { lengthM: 2.4, surface: "conveyor" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a fourth table section", () => {
    const result = easyLoaderSpecSchema.safeParse({
      ui: "-Y",
      usage: "onload",
      sections: new Array(4).fill({ lengthM: 1.2, surface: "static" }),
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than four roll-feed distances", () => {
    const result = easyLoaderSpecSchema.safeParse({
      ui: "-Y",
      usage: "offload",
      sections: [{ lengthM: 1.2, surface: "static" }],
      rollFeed: { qty: 5, distancesMm: [1, 2, 3, 4, 5] },
    });
    expect(result.success).toBe(false);
  });
});

describe("fabricProSpecSchema", () => {
  it("accepts a minimal spec", () => {
    expect(fabricProSpecSchema.safeParse({ ui: "+Y", travelPlatform: true }).success).toBe(true);
  });
});

describe("missingKeys", () => {
  it("reports nothing when every required key is present", () => {
    expect(missingKeys(validMSeries, ["ui", "knifeSize", "drills"])).toEqual([]);
  });

  it("reports an absent key", () => {
    expect(missingKeys({ ui: "+Y" }, ["ui", "knifeSize"])).toEqual(["knifeSize"]);
  });

  it("reports every key when the spec is null", () => {
    expect(missingKeys(null, ["ui", "knifeSize"])).toEqual(["ui", "knifeSize"]);
  });

  it("treats drills required with a blank detail as missing", () => {
    const spec = { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "" } };
    expect(missingKeys(spec, ["drills"])).toEqual(["drills"]);
  });

  it("treats drills required=false as satisfied", () => {
    const spec = { drills: { required: false, detail: "" } };
    expect(missingKeys(spec, ["drills"])).toEqual([]);
  });

  it("treats an empty sections array as missing", () => {
    expect(missingKeys({ sections: [] }, ["sections"])).toEqual(["sections"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/production-spec-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/validation/production-spec.ts`:

```ts
import { z } from "zod";

/**
 * Operator-screen side. Shared by every machine that has one, because a
 * cutter and its spreaders must agree -- see `lineGroup` in schema.prisma.
 */
export const screenSideSchema = z.enum(["+Y", "-Y"]);

/**
 * Drills. The printed form says `"TBC" is not acceptable`, so "required with
 * no detail" is not a valid state -- either there are no drills, or their
 * quantity, type and size are written down.
 */
export const drillsSchema = z
  .object({
    required: z.boolean(),
    detail: z.string().trim().max(22, "Drill detail must be 22 characters or fewer"),
  })
  .refine((value) => !value.required || value.detail.length > 0, {
    message: "Specify drill quantity, type and size",
    path: ["detail"],
  });

/**
 * The two free-text areas on the M-Series form are tall single rows with no
 * empty cells to their right, so text cannot overflow the way an address
 * line does -- it would simply be clipped. Hence the hard caps.
 */
export const mSeriesSpecSchema = z.object({
  ui: screenSideSchema,
  knifeSize: z.enum(["1.5x5.0", "1.5x7.0", "2.0x7.0"]),
  voltage: z.enum(["220V", "400V", "415V", "480V"]).optional(),
  drills: drillsSchema,
  specialNotes: z.string().trim().max(28, "Special notes must be 28 characters or fewer").optional(),
});

export const easyLoaderSpecSchema = z.object({
  ui: screenSideSchema,
  usage: z.enum(["onload", "offload"]),
  customWidthMm: z.number().int().positive().max(9999).optional(),
  sections: z
    .array(z.object({ lengthM: z.number().positive().max(99), surface: z.enum(["static", "conveyor"]) }))
    .max(3),
  rollFeed: z
    .object({ qty: z.number().int().min(1).max(4), distancesMm: z.array(z.number().int().min(0)).max(4) })
    .optional(),
  paperRollHolder: z.boolean().optional(),
  crate: z.boolean().optional(),
});

export const fabricProSpecSchema = z.object({
  ui: screenSideSchema,
  travelPlatform: z.boolean(),
  railLengthM: z.number().positive().max(99).optional(),
  powerRailLengthM: z.number().positive().max(99).optional(),
  exWorks: z.boolean().optional(),
  crate: z.boolean().optional(),
});

export type MSeriesSpec = z.infer<typeof mSeriesSpecSchema>;
export type EasyLoaderSpec = z.infer<typeof easyLoaderSpecSchema>;
export type FabricProSpec = z.infer<typeof fabricProSpecSchema>;

/**
 * Which of a form's `requires` keys are not yet answered. Drives both the
 * disabled download button and the 422 the route returns, so the UI and the
 * server can never disagree about what is missing.
 *
 * Two keys need more than a presence check: `drills` is satisfied by an
 * explicit "no drills", and `sections` is not satisfied by an empty array.
 */
export function missingKeys(spec: unknown, required: string[]): string[] {
  const record = (spec ?? {}) as Record<string, unknown>;

  return required.filter((key) => {
    const value = record[key];
    if (value === undefined || value === null) return true;

    if (key === "drills") {
      const drills = value as { required?: boolean; detail?: string };
      if (drills.required === false) return false;
      return !drills.detail || drills.detail.trim().length === 0;
    }

    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return value.trim().length === 0;

    return false;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/production-spec-validation.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/production-spec.ts tests/production-spec-validation.test.ts
git commit -m "feat: per-series production spec schemas and requirement checking"
```

---

## Task 7: Production spec actions

**Files:**
- Create: `src/lib/actions/production.ts`

- [ ] **Step 1: Write the actions**

Create `src/lib/actions/production.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { documentWhereForUser } from "@/lib/scope";
import { idSchema, flattenZodError } from "@/lib/validation/documents";
import type { ActionResult } from "@/lib/actions/documents";
import { specSchemaForCode } from "@/lib/production-forms/resolve";

const NOT_FOUND_ERROR = "Not found";

/**
 * Writes an item's production spec.
 *
 * Deliberately NOT gated on `status: "DRAFT"`, unlike every other item
 * mutation in src/lib/actions/documents.ts. The production spec carries no
 * commercial meaning -- it does not touch price, tax or totals -- so
 * requiring an unfinalize/refinalize cycle to correct a knife size would
 * churn document numbering for no gain. See spec section 4.1.
 *
 * `ui` is written to every item in the same `lineGroup`: a cutter and its
 * spreaders stand together and a mismatched operator-screen side is a
 * physical installation fault, not a cosmetic one.
 */
export async function setProductionSpec(itemId: string, spec: unknown): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  const item = await db.documentItem.findFirst({
    where: { id: parsedItemId.data, document: documentWhereForUser(session.user) },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  const schema = specSchemaForCode(item.code);
  if (!schema) return { error: "This item has no production form" };

  const parsed = schema.safeParse(spec);
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const ui = (parsed.data as { ui?: string }).ui;

  await db.$transaction(async (tx) => {
    await tx.documentItem.update({
      where: { id: item.id },
      data: { productionSpec: parsed.data as object },
    });

    if (!ui) return;

    const siblings = await tx.documentItem.findMany({
      where: { documentId: item.documentId, lineGroup: item.lineGroup, id: { not: item.id } },
    });

    for (const sibling of siblings) {
      const current = (sibling.productionSpec ?? {}) as Record<string, unknown>;
      if (current.ui === ui) continue;
      await tx.documentItem.update({
        where: { id: sibling.id },
        data: { productionSpec: { ...current, ui } },
      });
    }
  });

  revalidatePath(`/documents/${item.documentId}`);
  return {};
}

/**
 * Moves an item to a production line. Lines are plain integers (spec 4.2);
 * 1-9 is far beyond any real quote and keeps the chip a fixed size.
 */
export async function setItemLineGroup(itemId: string, lineGroup: number): Promise<ActionResult> {
  const session = await requireSession();

  const parsedItemId = idSchema.safeParse(itemId);
  if (!parsedItemId.success) return { error: NOT_FOUND_ERROR };

  if (!Number.isInteger(lineGroup) || lineGroup < 1 || lineGroup > 9) {
    return { error: "Line must be between 1 and 9" };
  }

  const item = await db.documentItem.findFirst({
    where: { id: parsedItemId.data, document: documentWhereForUser(session.user) },
  });
  if (!item) return { error: NOT_FOUND_ERROR };

  await db.documentItem.update({ where: { id: item.id }, data: { lineGroup } });

  revalidatePath(`/documents/${item.documentId}`);
  return {};
}
```

This imports `specSchemaForCode` from Task 11. Implement Task 11 before running `typecheck` on this file, or stub the import and return to it.

- [ ] **Step 2: Commit**

```bash
git add src/lib/actions/production.ts
git commit -m "feat: production spec actions with line-scoped screen side propagation"
```

---

## Task 8: Cell reference arithmetic

**Files:**
- Create: `src/lib/production-forms/cell-ref.ts`
- Test: `tests/cell-ref.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cell-ref.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { columnIndex, splitRef } from "../src/lib/production-forms/cell-ref";

describe("columnIndex", () => {
  it("maps A to 1", () => expect(columnIndex("A")).toBe(1));
  it("maps Z to 26", () => expect(columnIndex("Z")).toBe(26));
  it("maps AA to 27", () => expect(columnIndex("AA")).toBe(27));
  it("maps AZ to 52", () => expect(columnIndex("AZ")).toBe(52));
  it("orders G before M", () => expect(columnIndex("G")).toBeLessThan(columnIndex("M")));
  it("orders Z before AA", () => expect(columnIndex("Z")).toBeLessThan(columnIndex("AA")));
});

describe("splitRef", () => {
  it("splits a single-letter reference", () => {
    expect(splitRef("G8")).toEqual({ col: "G", colIndex: 7, row: 8 });
  });

  it("splits a two-letter reference", () => {
    expect(splitRef("AA108")).toEqual({ col: "AA", colIndex: 27, row: 108 });
  });

  it("throws on a malformed reference", () => {
    expect(() => splitRef("8G")).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cell-ref.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/production-forms/cell-ref.ts`:

```ts
/**
 * Spreadsheet address arithmetic. Needed because a cell we want to write may
 * be absent from the sheet XML entirely -- Excel omits empty cells -- so the
 * patcher has to insert a new `<c>` at the right place in column order.
 */

const REF_PATTERN = /^([A-Z]+)(\d+)$/;

/** "A" -> 1, "Z" -> 26, "AA" -> 27. */
export function columnIndex(col: string): number {
  let index = 0;
  for (const char of col) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

export function splitRef(ref: string): { col: string; colIndex: number; row: number } {
  const match = REF_PATTERN.exec(ref);
  if (!match) throw new Error(`Malformed cell reference: ${ref}`);
  return { col: match[1], colIndex: columnIndex(match[1]), row: Number(match[2]) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cell-ref.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-forms/cell-ref.ts tests/cell-ref.test.ts
git commit -m "feat: spreadsheet cell reference arithmetic"
```

---

## Task 9: The xlsx patcher

This is the file that carries all of the fidelity risk. Read spec §7.1 before writing it.

**Files:**
- Create: `src/lib/production-forms/xlsx-patch.ts`
- Create: `src/lib/production-forms/templates/m-series-order-12.xlsx`
- Test: `tests/xlsx-patch.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the zip dependency and commit the template**

```bash
npm install fflate
mkdir -p src/lib/production-forms/templates
cp "RAW/Order Forms/M-series order 12.xlsx" src/lib/production-forms/templates/m-series-order-12.xlsx
```

`fflate` is a dependency, not a devDependency — the route uses it at runtime.

- [ ] **Step 2: Write the failing test**

Create `tests/xlsx-patch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { patchSheetXml, patchWorkbook } from "../src/lib/production-forms/xlsx-patch";

const TEMPLATE = path.resolve(
  __dirname,
  "../src/lib/production-forms/templates/m-series-order-12.xlsx",
);
const SHEET = "xl/worksheets/sheet1.xml";

describe("patchSheetXml", () => {
  it("rewrites an existing cell as an inline string, keeping its style", () => {
    const xml = `<sheetData><row r="8"><c r="G8" s="42"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "Pathfinder" }]);
    expect(out).toContain(`<c r="G8" s="42" t="inlineStr">`);
    expect(out).toContain(`<t xml:space="preserve">Pathfinder</t>`);
  });

  it("drops an existing value from the cell it overwrites", () => {
    const xml = `<sheetData><row r="8"><c r="G8" s="42" t="s"><v>17</v></c></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    expect(out).not.toContain("<v>17</v>");
    expect(out).not.toContain(`t="s"`);
  });

  it("inserts a cell that is absent, in column order", () => {
    const xml = `<sheetData><row r="8"><c r="D8"/><c r="M8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    const order = [...out.matchAll(/<c r="([A-Z]+8)"/g)].map((m) => m[1]);
    expect(order).toEqual(["D8", "G8", "M8"]);
  });

  it("appends a cell whose column is past every existing cell", () => {
    const xml = `<sheetData><row r="8"><c r="D8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "M8", value: "X" }]);
    const order = [...out.matchAll(/<c r="([A-Z]+8)"/g)].map((m) => m[1]);
    expect(order).toEqual(["D8", "M8"]);
  });

  it("expands a self-closing row before inserting into it", () => {
    const xml = `<sheetData><row r="8" ht="12"/></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    expect(out).toContain(`<row r="8" ht="12">`);
    expect(out).toContain(`<c r="G8" t="inlineStr">`);
    expect(out).toContain("</row>");
  });

  it("inserts a row that is absent, in row order", () => {
    const xml = `<sheetData><row r="5"/><row r="12"/></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: "X" }]);
    const order = [...out.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([5, 8, 12]);
  });

  it("escapes XML-significant characters", () => {
    const xml = `<sheetData><row r="8"><c r="G8"/></row></sheetData>`;
    const out = patchSheetXml(xml, [{ cell: "G8", value: `Smith & Sons <Pty>` }]);
    expect(out).toContain("Smith &amp; Sons &lt;Pty&gt;");
  });

  it("applies several patches to the same row", () => {
    const xml = `<sheetData><row r="25"><c r="H25"/></row></sheetData>`;
    const out = patchSheetXml(xml, [
      { cell: "H25", value: "X" },
      { cell: "J25", value: "X" },
      { cell: "O25", value: "X" },
    ]);
    const order = [...out.matchAll(/<c r="([A-Z]+25)"/g)].map((m) => m[1]);
    expect(order).toEqual(["H25", "J25", "O25"]);
  });
});

describe("patchWorkbook", () => {
  it("writes the requested values into the real template", () => {
    const patched = patchWorkbook(readFileSync(TEMPLATE), SHEET, [
      { cell: "G8", value: "Pathfinder Australia Pty Ltd" },
      { cell: "J25", value: "X" },
    ]);
    const xml = strFromU8(unzipSync(patched)[SHEET]);
    expect(xml).toContain("Pathfinder Australia Pty Ltd");
    expect(xml).toContain(`<c r="J25"`);
  });

  it("leaves the content of every other archive entry unchanged", () => {
    const original = unzipSync(readFileSync(TEMPLATE));
    const patched = unzipSync(
      patchWorkbook(readFileSync(TEMPLATE), SHEET, [{ cell: "G8", value: "Pathfinder" }]),
    );

    expect(Object.keys(patched).sort()).toEqual(Object.keys(original).sort());

    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    for (const name of Object.keys(original)) {
      if (name === SHEET) continue;
      expect(digest(patched[name]), `entry changed: ${name}`).toBe(digest(original[name]));
    }
  });

  it("preserves the embedded images and print settings", () => {
    const patched = unzipSync(
      patchWorkbook(readFileSync(TEMPLATE), SHEET, [{ cell: "G8", value: "Pathfinder" }]),
    );
    expect(patched["xl/media/image1.jpeg"]).toBeDefined();
    expect(patched["xl/printerSettings/printerSettings1.bin"]).toBeDefined();
    expect(strFromU8(patched[SHEET])).toContain("pageSetup");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/xlsx-patch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `src/lib/production-forms/xlsx-patch.ts`:

```ts
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { splitRef } from "./cell-ref";

/**
 * Writes values into an .xlsx without disturbing anything else in it.
 *
 * An .xlsx is a zip. We unpack it, rewrite exactly one entry -- the worksheet
 * XML -- and repack. Styles, drawings, embedded images, print settings and
 * the print area are carried across untouched, so the printed form is the
 * form production already knows rather than a reconstruction of it. See
 * `patchWorkbook`'s test for the assertion that keeps this honest.
 *
 * Values are written as inline strings rather than shared strings. A shared
 * string would mean appending to sharedStrings.xml and renumbering, risking a
 * shift in every other string in the workbook; an inline string is local to
 * its own cell and cannot affect anything else.
 */

export type CellPatch = { cell: string; value: string };

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellXml(ref: string, style: string | null, value: string): string {
  const s = style === null ? "" : ` s="${style}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** The `<row>` element for `row`, as a slice of `xml`, or null when absent. */
function findRow(xml: string, row: number): { start: number; end: number } | null {
  const open = new RegExp(`<row[^>]*\\br="${row}"[^>]*?(/>|>)`);
  const match = open.exec(xml);
  if (!match) return null;

  if (match[1] === "/>") {
    return { start: match.index, end: match.index + match[0].length };
  }

  const close = xml.indexOf("</row>", match.index);
  if (close === -1) throw new Error(`Unterminated <row r="${row}">`);
  return { start: match.index, end: close + "</row>".length };
}

/** Turns `<row r="8" ht="12"/>` into `<row r="8" ht="12"></row>`. */
function expandSelfClosingRow(rowXml: string): string {
  if (!rowXml.endsWith("/>")) return rowXml;
  return `${rowXml.slice(0, -2)}></row>`;
}

function patchCellInRow(rowXml: string, ref: string, value: string): string {
  const existing = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const match = existing.exec(rowXml);

  if (match) {
    const style = /\bs="(\d+)"/.exec(match[1]);
    return rowXml.replace(existing, cellXml(ref, style ? style[1] : null, value));
  }

  const expanded = expandSelfClosingRow(rowXml);
  const target = splitRef(ref).colIndex;

  // Insert before the first cell that sorts after ours; otherwise append.
  for (const cell of expanded.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    if (splitRef(cell[1]).colIndex > target) {
      const at = cell.index;
      return expanded.slice(0, at) + cellXml(ref, null, value) + expanded.slice(at);
    }
  }

  const closeAt = expanded.lastIndexOf("</row>");
  return expanded.slice(0, closeAt) + cellXml(ref, null, value) + expanded.slice(closeAt);
}

/** Inserts a new `<row>` into `<sheetData>` in row order. */
function insertRow(xml: string, row: number, inner: string): string {
  const newRow = `<row r="${row}">${inner}</row>`;

  for (const existing of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*?(?:\/>|>)/g)) {
    if (Number(existing[1]) > row) {
      return xml.slice(0, existing.index) + newRow + xml.slice(existing.index);
    }
  }

  const closeAt = xml.indexOf("</sheetData>");
  if (closeAt === -1) throw new Error("No </sheetData> in worksheet XML");
  return xml.slice(0, closeAt) + newRow + xml.slice(closeAt);
}

export function patchSheetXml(xml: string, patches: CellPatch[]): string {
  // Group by row so each row is located and rewritten once, and so offsets
  // from an earlier insert cannot invalidate a later one.
  const byRow = new Map<number, CellPatch[]>();
  for (const patch of patches) {
    const { row } = splitRef(patch.cell);
    byRow.set(row, [...(byRow.get(row) ?? []), patch]);
  }

  let out = xml;

  for (const [row, rowPatches] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const found = findRow(out, row);

    if (!found) {
      let inner = "";
      for (const patch of rowPatches.sort(
        (a, b) => splitRef(a.cell).colIndex - splitRef(b.cell).colIndex,
      )) {
        inner += cellXml(patch.cell, null, patch.value);
      }
      out = insertRow(out, row, inner);
      continue;
    }

    let rowXml = out.slice(found.start, found.end);
    for (const patch of rowPatches) {
      rowXml = patchCellInRow(rowXml, patch.cell, patch.value);
    }
    out = out.slice(0, found.start) + rowXml + out.slice(found.end);
  }

  return out;
}

export function patchWorkbook(
  template: Uint8Array,
  sheetPath: string,
  patches: CellPatch[],
): Uint8Array {
  const files = unzipSync(template);

  const sheet = files[sheetPath];
  if (!sheet) throw new Error(`Template has no ${sheetPath}`);

  files[sheetPath] = strToU8(patchSheetXml(strFromU8(sheet), patches));

  return zipSync(files);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/xlsx-patch.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/production-forms/xlsx-patch.ts src/lib/production-forms/templates tests/xlsx-patch.test.ts package.json package-lock.json
git commit -m "feat: lossless xlsx cell patcher writing inline strings"
```

---

## Task 10: Form types and the M-Series spec

**Files:**
- Create: `src/lib/production-forms/types.ts`
- Create: `src/lib/production-forms/specs/m-series.ts`
- Create: `src/lib/production-forms/specs/index.ts`

- [ ] **Step 1: Write the types**

Create `src/lib/production-forms/types.ts`:

```ts
import type { z } from "zod";

/** One quote item, flattened for form rendering. */
export type FormItem = {
  id: string;
  code: string;
  name: string;
  lineGroup: number;
  spec: Record<string, unknown>;
  /** Option codes on this item, e.g. ["VRB-220", "MTS", "HFV-M"]. */
  optionCodes: string[];
  /** Attribute bags keyed by option code, e.g. { MTS: { metres: 14 } }. */
  optionAttributes: Record<string, Record<string, unknown>>;
};

/** Everything a form needs that is not the item itself. */
export type FormContext = {
  distributorName: string;
  authorName: string;
  company: { name: string; addressLines: string[]; industry: string | null };
  contact: { fullName: string; position: string | null; phone: string | null; email: string | null };
  deliveryAddressLines: string[];
  /** Document-level software product codes, e.g. ["PTW(I)", "ANT-V6"]. */
  softwareCodes: string[];
  item: FormItem;
};

export type FormSpec = {
  id: string;
  title: string;
  template: string;
  /** Path of the worksheet inside the xlsx zip. */
  sheetPath: string;
  matches: (code: string) => boolean;
  /** Written into blank cells. */
  values: Array<{ cell: string; from: (ctx: FormContext) => string | number | null | undefined }>;
  /** Overwrites printed label text -- rare, and declared separately so it is visible. */
  replaces: Array<{ cell: string; from: (ctx: FormContext) => string | null | undefined }>;
  /**
   * `covers` names the option code pattern a tick consumes. It is what lets
   * the engine work out which of an item's options the form has no box for --
   * a tick's `when` alone cannot say that, and an option that silently
   * vanishes is the worst failure this feature could have. Ticks driven by
   * the product code or the production spec leave it undefined.
   */
  ticks: Array<{ cell: string; when: (ctx: FormContext) => boolean; covers?: RegExp }>;
  /** productionSpec keys that block generation while unanswered. */
  requires: string[];
  specSchema: z.ZodTypeAny;
};
```

- [ ] **Step 2: Write the M-Series spec**

Create `src/lib/production-forms/specs/m-series.ts`. Cell coordinates come from spec §5.1 — do not adjust them without re-reading the template.

```ts
import { mSeriesSpecSchema } from "@/lib/validation/production-spec";
import type { FormContext, FormSpec } from "../types";

const CODE = /^M(3|5|7|10)(180|220|300|390)$/;

/** Model and width are only recoverable from the code -- Product.specs is null for every row. */
function parseCode(code: string): { model: string; width: number } | null {
  const match = CODE.exec(code);
  if (!match) return null;
  return { model: `M${match[1]}`, width: Number(match[2]) };
}

const model = (want: string) => (ctx: FormContext) => parseCode(ctx.item.code)?.model === want;
const width = (want: number) => (ctx: FormContext) => parseCode(ctx.item.code)?.width === want;

/**
 * An option tick. Catalog codes carry series suffixes (ABR-M) while the form
 * prints base codes, so matching is by pattern. `covers` records the same
 * pattern so `unmatchedOptionCodes` can tell what this form has no box for.
 */
const optionTick = (cell: string, pattern: RegExp) => ({
  cell,
  when: (ctx: FormContext) => ctx.item.optionCodes.some((code) => pattern.test(code)),
  covers: pattern,
});

const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

/**
 * PathWorks modules tick this form only when the quote carries the integrated
 * PathWorks. With the standalone one they belong on the Software Order Form
 * instead -- two different orders, not a duplication. See spec section 6.3.
 */
const integrated = (moduleCode: string) => (ctx: FormContext) =>
  ctx.softwareCodes.includes("PTW(I)") && ctx.softwareCodes.includes(moduleCode);

export const mSeriesSpec: FormSpec = {
  id: "m-series",
  title: "M-Series Order Form",
  template: "m-series-order-12.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  matches: (code) => CODE.test(code),
  specSchema: mSeriesSpecSchema,
  requires: ["ui", "knifeSize", "drills"],

  values: [
    { cell: "G8", from: (c) => c.distributorName },
    // N8, not M8: the "Name:" label sits in the 4.3-character-wide L8 and
    // depends on overflowing rightwards. Writing into M8 clips it to "Nam".
    { cell: "N8", from: (c) => c.authorName },
    { cell: "H13", from: (c) => c.company.name },
    { cell: "H14", from: (c) => c.company.addressLines[0] },
    { cell: "H15", from: (c) => c.company.addressLines[1] },
    { cell: "H16", from: (c) => c.contact.fullName },
    { cell: "H17", from: (c) => c.contact.position },
    { cell: "H18", from: (c) => c.contact.phone },
    { cell: "H20", from: (c) => c.contact.email },
    { cell: "H21", from: (c) => c.company.industry },
    { cell: "M13", from: (c) => c.deliveryAddressLines[0] },
    { cell: "M14", from: (c) => c.deliveryAddressLines[1] },
    { cell: "M15", from: (c) => c.deliveryAddressLines[2] },
    { cell: "M73", from: (c) => c.item.optionAttributes["MTS"]?.metres as number | undefined },
    // Rows 81-82 are the tall hand-writing rows and carry a large font, so
    // very little fits and the drills and notes columns collide. Cells and
    // caps below are the ones measured in the spike -- do not widen them
    // without printing a page and looking at it.
    { cell: "H81", from: (c) => ((c.item.spec.drills as { required?: boolean })?.required ? "Yes" : "No") },
    { cell: "J82", from: (c) => (c.item.spec.drills as { detail?: string })?.detail },
    { cell: "N81", from: (c) => c.item.spec.specialNotes as string | undefined },
  ],

  replaces: [],

  ticks: [
    { cell: "H25", when: model("M3") },
    { cell: "J25", when: model("M5") },
    { cell: "L25", when: model("M7") },
    { cell: "O25", when: model("M10") },

    { cell: "H29", when: width(180) },
    { cell: "J29", when: width(220) },
    { cell: "L29", when: width(300) },
    { cell: "O29", when: width(390) },

    { cell: "J33", when: spec("ui", "+Y") },
    { cell: "J35", when: spec("ui", "-Y") },

    optionTick("F42", /^VRB/),
    optionTick("J42", /^OFJ$/),
    optionTick("O42", /^HFV/),
    optionTick("F44", /^PM-/),
    optionTick("J44", /^OFD/),
    optionTick("O44", /^PRM/),
    optionTick("F46", /^APM/),
    optionTick("J46", /^OFP/),
    optionTick("O46", /^DMT$/),
    optionTick("F48", /^DRG-3$/),
    optionTick("J48", /^MRK$/),
    optionTick("O48", /^Crate/),
    optionTick("F50", /^DRG-1$/),
    optionTick("J50", /^IJP$/),
    optionTick("F52", /^HDC/),
    optionTick("J52", /^ABR/),
    optionTick("F55", /^BCR/),
    optionTick("J55", /^DR2$/),
    optionTick("F57", /^IKA$/),
    optionTick("J57", /^AFP$/),

    // O, not P. Every options row on this form is a box-then-label pair
    // (F→G, J→K, O→P); P holds the printed "220V (TR220 External Xfmr)" text.
    // The contract test caught this aimed one column right.
    { cell: "O50", when: spec("voltage", "220V") },
    { cell: "O52", when: spec("voltage", "400V") },
    { cell: "O55", when: spec("voltage", "415V") },
    { cell: "O57", when: spec("voltage", "480V") },

    { cell: "F62", when: integrated("PDG") },
    { cell: "J62", when: integrated("WPN") },
    { cell: "O62", when: integrated("WPL") },
    { cell: "F64", when: integrated("ANT-V5") },
    { cell: "J64", when: integrated("ANT-V6") },

    { cell: "F68", when: spec("knifeSize", "1.5x5.0") },
    { cell: "J68", when: spec("knifeSize", "1.5x7.0") },
    { cell: "O68", when: spec("knifeSize", "2.0x7.0") },

    optionTick("D72", /^MTS$/),
  ],
};
```

The voltage ticks are the one coordinate the contract test in Task 15 caught: they were written as `P50`/`P52`/`P55`/`P57`, which is the *label* column holding "220V (TR220 External Xfmr)" and friends. Every options row on this form is a box-then-label pair — `F→G`, `J→K`, `O→P` — so the boxes are `O50`/`O52`/`O55`/`O57`. Still confirm them visually the first time a form with a voltage is printed.

- [ ] **Step 3: Write the registry**

Create `src/lib/production-forms/specs/index.ts`:

```ts
import type { FormSpec } from "../types";
import { mSeriesSpec } from "./m-series";

/** Order is irrelevant: matching is by product code and pages follow item sortOrder. */
export const FORM_SPECS: FormSpec[] = [mSeriesSpec];
```

- [ ] **Step 4: Verify types**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-forms/types.ts src/lib/production-forms/specs
git commit -m "feat: form spec types and M-Series cell map"
```

---

## Task 11: Resolution — item to form, spec to patches

**Files:**
- Create: `src/lib/production-forms/resolve.ts`
- Test: `tests/production-forms-resolve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/production-forms-resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  resolveForm,
  specSchemaForCode,
  buildPatches,
  missingRequirements,
  unmatchedOptionCodes,
} from "../src/lib/production-forms/resolve";
import type { FormContext, FormItem } from "../src/lib/production-forms/types";

function item(overrides: Partial<FormItem> = {}): FormItem {
  return {
    id: "item1",
    code: "M5220",
    name: "M-Series",
    lineGroup: 1,
    spec: { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: false, detail: "" } },
    optionCodes: [],
    optionAttributes: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<FormContext> = {}): FormContext {
  return {
    distributorName: "Pathfinder Australia Pty Ltd",
    authorName: "Vadym H",
    company: { name: "Relaxvanguard", addressLines: ["12 Industrial Dr"], industry: "Automotive" },
    contact: { fullName: "John Smith", position: "Manager", phone: "+61", email: "j@example.com" },
    deliveryAddressLines: ["12 Industrial Dr"],
    softwareCodes: [],
    item: item(),
    ...overrides,
  };
}

describe("resolveForm", () => {
  it("matches every M-Series code", () => {
    for (const code of ["M3180", "M5220", "M7300", "M10390"]) {
      expect(resolveForm(code)?.id).toBe("m-series");
    }
  });

  it("does not match a software product", () => {
    expect(resolveForm("PTW(I)")).toBeNull();
  });

  it("does not match an unknown code", () => {
    expect(resolveForm("NOPE-1")).toBeNull();
  });
});

describe("specSchemaForCode", () => {
  it("returns the M-Series schema for an M-Series code", () => {
    expect(specSchemaForCode("M5220")).toBeDefined();
  });

  it("returns null for a code with no form", () => {
    expect(specSchemaForCode("SERVICE")).toBeNull();
  });
});

describe("buildPatches", () => {
  it("ticks the model and width boxes for the item code", () => {
    const patches = buildPatches(resolveForm("M5220")!, ctx());
    const cells = patches.map((p) => p.cell);
    expect(cells).toContain("J25");
    expect(cells).toContain("J29");
    expect(cells).not.toContain("H25");
  });

  it("writes X into every tick cell", () => {
    const patches = buildPatches(resolveForm("M5220")!, ctx());
    expect(patches.find((p) => p.cell === "J25")?.value).toBe("X");
  });

  it("ticks a suffixed catalog option against its base-code box", () => {
    const patches = buildPatches(
      resolveForm("M5220")!,
      ctx({ item: item({ optionCodes: ["ABR-M", "HDC-M"] }) }),
    );
    const cells = patches.map((p) => p.cell);
    expect(cells).toContain("J52");
    expect(cells).toContain("F52");
  });

  it("ticks PathWorks modules only alongside the integrated PathWorks", () => {
    const withIntegrated = buildPatches(
      resolveForm("M5220")!,
      ctx({ softwareCodes: ["PTW(I)", "ANT-V6"] }),
    ).map((p) => p.cell);
    expect(withIntegrated).toContain("J64");

    const withStandalone = buildPatches(
      resolveForm("M5220")!,
      ctx({ softwareCodes: ["PTW(S)", "ANT-V6"] }),
    ).map((p) => p.cell);
    expect(withStandalone).not.toContain("J64");
  });

  it("omits value cells whose source is empty", () => {
    const patches = buildPatches(
      resolveForm("M5220")!,
      ctx({ company: { name: "Relaxvanguard", addressLines: [], industry: null } }),
    );
    const cells = patches.map((p) => p.cell);
    expect(cells).not.toContain("H14");
    expect(cells).not.toContain("H21");
  });

  it("writes an option attribute as a string", () => {
    const patches = buildPatches(
      resolveForm("M5220")!,
      ctx({ item: item({ optionCodes: ["MTS"], optionAttributes: { MTS: { metres: 14 } } }) }),
    );
    expect(patches.find((p) => p.cell === "M73")?.value).toBe("14");
  });
});

describe("unmatchedOptionCodes", () => {
  it("reports nothing when every option has a box", () => {
    const context = ctx({ item: item({ optionCodes: ["ABR-M", "HDC-M", "MTS"] }) });
    expect(unmatchedOptionCodes(resolveForm("M5220")!, context)).toEqual([]);
  });

  it("reports an option the form has no box for", () => {
    const context = ctx({ item: item({ optionCodes: ["ABR-M", "EDS-500"] }) });
    expect(unmatchedOptionCodes(resolveForm("M5220")!, context)).toEqual(["EDS-500"]);
  });

  it("does not treat a tick driven by the production spec as covering an option", () => {
    const context = ctx({ item: item({ optionCodes: ["1.0mm dia punch"] }) });
    expect(unmatchedOptionCodes(resolveForm("M5220")!, context)).toEqual(["1.0mm dia punch"]);
  });
});

describe("missingRequirements", () => {
  it("reports nothing for a complete spec", () => {
    expect(missingRequirements(resolveForm("M5220")!, item().spec)).toEqual([]);
  });

  it("reports every requirement when the spec is empty", () => {
    expect(missingRequirements(resolveForm("M5220")!, {})).toEqual(["ui", "knifeSize", "drills"]);
  });

  it("reports drills when they are required with no detail", () => {
    const spec = { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "" } };
    expect(missingRequirements(resolveForm("M5220")!, spec)).toEqual(["drills"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/production-forms-resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/production-forms/resolve.ts`:

```ts
import type { z } from "zod";
import { missingKeys } from "@/lib/validation/production-spec";
import { FORM_SPECS } from "./specs";
import type { CellPatch } from "./xlsx-patch";
import type { FormContext, FormSpec } from "./types";

/**
 * Which form a quote item prints on. Matching is by product code, not series:
 * HDRF-180/220/320 live in the EF series alongside EasyFeeder but have their
 * own form, so series-level matching would be wrong.
 */
export function resolveForm(code: string): FormSpec | null {
  return FORM_SPECS.find((spec) => spec.matches(code)) ?? null;
}

/** The productionSpec schema for an item, or null when it prints no form. */
export function specSchemaForCode(code: string): z.ZodTypeAny | null {
  return resolveForm(code)?.specSchema ?? null;
}

/** Which of a form's requirements this item has not answered yet. */
export function missingRequirements(spec: FormSpec, productionSpec: unknown): string[] {
  return missingKeys(productionSpec, spec.requires);
}

/**
 * Turns a spec plus a context into the exact list of cell writes. A tick is
 * the literal "X"; the cell's border and centring already live in the
 * template. Empty values are skipped so a missing optional never blanks a
 * cell that was meant to stay untouched.
 */
export function buildPatches(spec: FormSpec, ctx: FormContext): CellPatch[] {
  const patches: CellPatch[] = [];

  for (const { cell, from } of spec.values) {
    const value = from(ctx);
    if (value === null || value === undefined || value === "") continue;
    patches.push({ cell, value: String(value) });
  }

  for (const { cell, from } of spec.replaces) {
    const value = from(ctx);
    if (value === null || value === undefined) continue;
    patches.push({ cell, value });
  }

  for (const { cell, when } of spec.ticks) {
    if (when(ctx)) patches.push({ cell, value: "X" });
  }

  return patches;
}

/**
 * Option codes on this item that the form has no box for.
 *
 * These are not dropped: they go on the "Additional items" sheet. An option
 * the workshop never sees is the worst thing this feature could do, so the
 * absence of a box has to be detectable rather than invisible -- which is
 * what `covers` on each option tick exists for.
 */
export function unmatchedOptionCodes(spec: FormSpec, ctx: FormContext): string[] {
  const covered = spec.ticks
    .map((tick) => tick.covers)
    .filter((pattern): pattern is RegExp => pattern !== undefined);

  return ctx.item.optionCodes.filter((code) => !covered.some((pattern) => pattern.test(code)));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/production-forms-resolve.test.ts`
Expected: PASS, 17 tests.

If a test naming a specific cell fails, the coordinate in `m-series.ts` is wrong — check it against spec §5.1 and the template before changing the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-forms/resolve.ts tests/production-forms-resolve.test.ts
git commit -m "feat: resolve items to forms and build cell patches"
```

---

## Task 12: Build the form context from a document

**Files:**
- Create: `src/lib/production-forms/context.ts`
- Test: `tests/production-forms-context.test.ts`

Read `src/lib/sheet-data.ts` first — `buildFormContext` follows the same shape: take the Prisma document the builder query already returns, and flatten it into plain data with no Prisma types leaking out.

- [ ] **Step 1: Write the failing test**

Create `tests/production-forms-context.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFormContexts, companyAddressLines } from "../src/lib/production-forms/context";

const baseDocument = {
  id: "doc1",
  number: "Q-AU-2026-001",
  entitySnapshot: { entityName: "Pathfinder Australia Pty Ltd" },
  region: { entityName: "Pathfinder Australia Pty Ltd" },
  author: { name: "Vadym H" },
  company: {
    name: "Relaxvanguard",
    street: "12 Industrial Drive",
    city: "Dandenong South",
    state: "VIC",
    postcode: "3175",
    country: "AU",
    deliverySameAsMain: true,
    deliveryStreet: null,
    deliveryCity: null,
    deliveryState: null,
    deliveryPostcode: null,
    deliveryCountry: null,
    industry: { name: "Automotive" },
  },
  contact: { firstName: "John", lastName: "Smith", position: "Manager", phone: "+61 3", email: "j@e.com" },
  items: [
    {
      id: "item1",
      code: "M5220",
      name: "M-Series",
      lineGroup: 1,
      productionSpec: { ui: "+Y" },
      lines: [
        { kind: "OPTION", code: "MTS", name: "Machine Transfer System", qty: 1, attributes: { metres: 14 } },
        { kind: "OPTION", code: "ABR-M", name: "Air Brush", qty: 1, attributes: null },
      ],
    },
    {
      id: "item2",
      code: "PTW(I)",
      name: "PathWorks Integrated",
      lineGroup: 1,
      productionSpec: null,
      lines: [],
    },
  ],
  lines: [],
};

describe("companyAddressLines", () => {
  it("joins city, state and postcode onto one line", () => {
    expect(companyAddressLines(baseDocument.company)).toEqual([
      "12 Industrial Drive",
      "Dandenong South VIC 3175",
      "Australia",
    ]);
  });

  it("skips absent parts rather than leaving gaps", () => {
    const lines = companyAddressLines({ ...baseDocument.company, state: null, postcode: null });
    expect(lines).toEqual(["12 Industrial Drive", "Dandenong South", "Australia"]);
  });
});

describe("buildFormContexts", () => {
  it("builds one context per item that has a form", () => {
    const contexts = buildFormContexts(baseDocument as never);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].item.code).toBe("M5220");
  });

  it("takes the distributor from the frozen entity snapshot", () => {
    expect(buildFormContexts(baseDocument as never)[0].distributorName).toBe(
      "Pathfinder Australia Pty Ltd",
    );
  });

  it("falls back to the live region entity when there is no snapshot", () => {
    const doc = { ...baseDocument, entitySnapshot: null };
    expect(buildFormContexts(doc as never)[0].distributorName).toBe("Pathfinder Australia Pty Ltd");
  });

  it("collects option codes and attributes onto the item", () => {
    const item = buildFormContexts(baseDocument as never)[0].item;
    expect(item.optionCodes).toEqual(["MTS", "ABR-M"]);
    expect(item.optionAttributes["MTS"]).toEqual({ metres: 14 });
  });

  it("exposes items without a form as software codes", () => {
    expect(buildFormContexts(baseDocument as never)[0].softwareCodes).toContain("PTW(I)");
  });

  it("reuses the main address as delivery when they are the same", () => {
    const ctx = buildFormContexts(baseDocument as never)[0];
    expect(ctx.deliveryAddressLines).toEqual(ctx.company.addressLines);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/production-forms-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/production-forms/context.ts`:

```ts
import { displayCountry } from "@/lib/countries";
import { resolveForm } from "./resolve";
import type { FormContext, FormItem } from "./types";

type AddressLike = {
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
};

/**
 * Three lines, matching the three underlined address rows every form prints.
 * Absent parts are skipped rather than left as gaps, so a company with no
 * state does not print a stray double space.
 */
export function companyAddressLines(address: AddressLike): string[] {
  const locality = [address.city, address.state, address.postcode].filter(Boolean).join(" ");
  const country = address.country ? displayCountry(address.country) : null;
  return [address.street, locality || null, country].filter((line): line is string => Boolean(line));
}

/**
 * Flattens the document the builder query already returns into one context
 * per item that prints a form. Items with no form -- software, services --
 * do not get a context; their codes are exposed on every context as
 * `softwareCodes` so a form can ask whether PathWorks Integrated was sold.
 */
export function buildFormContexts(document: DocumentForForms): FormContext[] {
  const snapshot = document.entitySnapshot as { entityName?: string } | null;
  const distributorName = snapshot?.entityName ?? document.region.entityName;

  const company = document.company;
  const addressLines = company ? companyAddressLines(company) : [];

  const deliveryAddressLines =
    company && !company.deliverySameAsMain
      ? companyAddressLines({
          street: company.deliveryStreet,
          city: company.deliveryCity,
          state: company.deliveryState,
          postcode: company.deliveryPostcode,
          country: company.deliveryCountry,
        })
      : addressLines;

  const softwareCodes = document.items
    .filter((item) => resolveForm(item.code) === null)
    .map((item) => item.code);

  return document.items
    .filter((item) => resolveForm(item.code) !== null)
    .map((item) => {
      const options = item.lines.filter((line) => line.kind === "OPTION");

      const formItem: FormItem = {
        id: item.id,
        code: item.code,
        name: item.name,
        lineGroup: item.lineGroup,
        spec: (item.productionSpec ?? {}) as Record<string, unknown>,
        optionCodes: options.map((line) => line.code).filter((c): c is string => Boolean(c)),
        optionAttributes: Object.fromEntries(
          options
            .filter((line) => line.code && line.attributes)
            .map((line) => [line.code as string, line.attributes as Record<string, unknown>]),
        ),
      };

      return {
        distributorName,
        authorName: document.author.name ?? "",
        company: {
          name: company?.name ?? "",
          addressLines,
          industry: company?.industry?.name ?? null,
        },
        contact: {
          fullName: [document.contact?.firstName, document.contact?.lastName].filter(Boolean).join(" "),
          position: document.contact?.position ?? null,
          phone: document.contact?.phone ?? null,
          email: document.contact?.email ?? null,
        },
        deliveryAddressLines,
        softwareCodes,
        item: formItem,
      };
    });
}
```

Define `DocumentForForms` as the return type of the query you add in Task 14 (`Prisma.DocumentGetPayload<typeof productionFormsInclude>`), the same way `src/lib/sheet-data.ts` types its input. Until Task 14 exists, type it locally and tighten it then.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/production-forms-context.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/production-forms/context.ts tests/production-forms-context.test.ts
git commit -m "feat: build production form context from a document"
```

---

## Task 13: EasyLoader and FabricPro specs

**Files:**
- Create: `src/lib/production-forms/specs/easyloader.ts`
- Create: `src/lib/production-forms/specs/fabricpro.ts`
- Create: `src/lib/production-forms/templates/easy-loader-13.xlsx`
- Create: `src/lib/production-forms/templates/fabric-pro-order-form-08.xlsx`
- Modify: `src/lib/production-forms/specs/index.ts`
- Test: `tests/production-forms-resolve.test.ts` (extend)

- [ ] **Step 1: Copy the templates**

```bash
cp "RAW/Order Forms/Easy Loader 13.xlsx" src/lib/production-forms/templates/easy-loader-13.xlsx
cp "RAW/Order Forms/Fabric Pro order form 08.xlsx" src/lib/production-forms/templates/fabric-pro-order-form-08.xlsx
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/production-forms-resolve.test.ts`:

```ts
describe("EasyLoader form", () => {
  const elItem = {
    id: "i", code: "EL-2420", name: "EasyLoader 2420", lineGroup: 1,
    spec: { ui: "-Y", usage: "onload", sections: [{ lengthM: 2.4, surface: "static" }] },
    optionCodes: [], optionAttributes: {},
  };

  it("matches EasyLoader codes only", () => {
    expect(resolveForm("EL-2420")?.id).toBe("easyloader");
    expect(resolveForm("EF-2420")?.id).not.toBe("easyloader");
  });

  it("ticks the printed width box for a standard model", () => {
    const cells = buildPatches(resolveForm("EL-2420")!, ctx({ item: elItem as never })).map((p) => p.cell);
    expect(cells).toContain("I33");
    expect(cells).not.toContain("I35");
  });

  it("ticks Custom and rewrites the label for a non-standard width", () => {
    const item = { ...elItem, code: "EL-3220", spec: { ...elItem.spec, customWidthMm: 3220 } };
    const patches = buildPatches(resolveForm("EL-3220")!, ctx({ item: item as never }));
    expect(patches.find((p) => p.cell === "I35")?.value).toBe("X");
    expect(patches.find((p) => p.cell === "J35")?.value).toContain("3220mm");
  });

  it("writes each table section length and surface", () => {
    const item = {
      ...elItem,
      spec: {
        ...elItem.spec,
        sections: [
          { lengthM: 2.4, surface: "static" },
          { lengthM: 1.2, surface: "conveyor" },
        ],
      },
    };
    const patches = buildPatches(resolveForm("EL-2420")!, ctx({ item: item as never }));
    expect(patches.find((p) => p.cell === "I43")?.value).toBe("2.4");
    expect(patches.find((p) => p.cell === "I45")?.value).toBe("X");
    expect(patches.find((p) => p.cell === "I47")?.value).toBe("1.2");
    expect(patches.find((p) => p.cell === "K49")?.value).toBe("X");
  });

  it("requires screen side, usage and sections", () => {
    expect(missingRequirements(resolveForm("EL-2420")!, {})).toEqual(["ui", "usage", "sections"]);
  });
});

describe("FabricPro form", () => {
  const fpItem = {
    id: "i", code: "FP-220", name: "FabricPro 220", lineGroup: 1,
    spec: { ui: "+Y", travelPlatform: true, railLengthM: 6 },
    optionCodes: [], optionAttributes: {},
  };

  it("matches FP models but not the trolley", () => {
    expect(resolveForm("FP-220")?.id).toBe("fabricpro");
    expect(resolveForm("FP-TROLLEY")).toBeNull();
  });

  it("ticks the model, screen side and travel platform", () => {
    const cells = buildPatches(resolveForm("FP-220")!, ctx({ item: fpItem as never })).map((p) => p.cell);
    expect(cells).toEqual(expect.arrayContaining(["J27", "O41", "J44", "J46"]));
  });

  it("writes the travel rail length", () => {
    const patches = buildPatches(resolveForm("FP-220")!, ctx({ item: fpItem as never }));
    expect(patches.find((p) => p.cell === "N46")?.value).toBe("6");
  });

  it("requires only the screen side", () => {
    expect(missingRequirements(resolveForm("FP-220")!, {})).toEqual(["ui"]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/production-forms-resolve.test.ts`
Expected: FAIL — `resolveForm("EL-2420")` returns null.

- [ ] **Step 4: Write the EasyLoader spec**

Create `src/lib/production-forms/specs/easyloader.ts`. Coordinates come from spec §5.2.

```ts
import { easyLoaderSpecSchema } from "@/lib/validation/production-spec";
import type { FormContext, FormSpec } from "../types";

const CODE = /^EL-\d{4}$/;
/** Only these two have a printed box; everything else ticks Custom. */
const PRINTED_WIDTHS: Record<string, string> = { "EL-2020": "I31", "EL-2420": "I33" };

type Section = { lengthM: number; surface: "static" | "conveyor" };

const sections = (ctx: FormContext) => (ctx.item.spec.sections ?? []) as Section[];
const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

/** Length value box and the two surface tick boxes, per table section. */
const SECTION_CELLS = [
  { length: "I43", static: "I45", conveyor: "K45" },
  { length: "I47", static: "I49", conveyor: "K49" },
  { length: "I51", static: "I53", conveyor: "K53" },
];

export const easyLoaderSpec: FormSpec = {
  id: "easyloader",
  title: "EasyLoader Order Form",
  template: "easy-loader-13.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  matches: (code) => CODE.test(code),
  specSchema: easyLoaderSpecSchema,
  requires: ["ui", "usage", "sections"],

  values: [
    { cell: "G11", from: (c) => c.distributorName },
    { cell: "N11", from: (c) => c.authorName },
    { cell: "H16", from: (c) => c.company.name },
    { cell: "H17", from: (c) => c.company.addressLines[0] },
    { cell: "H18", from: (c) => c.company.addressLines[1] },
    { cell: "H19", from: (c) => c.contact.fullName },
    { cell: "H20", from: (c) => c.contact.position },
    { cell: "H21", from: (c) => c.contact.phone },
    { cell: "H23", from: (c) => c.contact.email },
    { cell: "H24", from: (c) => c.company.industry },
    { cell: "O16", from: (c) => c.deliveryAddressLines[0] },
    { cell: "O17", from: (c) => c.deliveryAddressLines[1] },
    { cell: "O18", from: (c) => c.deliveryAddressLines[2] },
    ...SECTION_CELLS.map((cells, index) => ({
      cell: cells.length,
      from: (c: FormContext) => sections(c)[index]?.lengthM,
    })),
    { cell: "F61", from: (c) => (c.item.spec.rollFeed as { qty?: number })?.qty },
    ...["K61", "K63", "K65", "K67"].map((cell, index) => ({
      cell,
      from: (c: FormContext) =>
        (c.item.spec.rollFeed as { distancesMm?: number[] })?.distancesMm?.[index],
    })),
  ],

  // J35 holds the printed label "  Custom     ___________mm". There is no
  // blank beside it, so the whole label is rewritten. This is the only place
  // in any spec that overwrites printed text -- hence its own field.
  replaces: [
    {
      cell: "J35",
      from: (c) => {
        const width = c.item.spec.customWidthMm as number | undefined;
        return width ? `  Custom     ${width}mm` : null;
      },
    },
  ],

  ticks: [
    { cell: "I31", when: (c) => PRINTED_WIDTHS[c.item.code] === "I31" },
    { cell: "I33", when: (c) => PRINTED_WIDTHS[c.item.code] === "I33" },
    { cell: "I35", when: (c) => PRINTED_WIDTHS[c.item.code] === undefined },

    { cell: "I38", when: spec("usage", "onload") },
    { cell: "O38", when: spec("usage", "offload") },
    { cell: "I40", when: spec("ui", "-Y") },
    { cell: "O40", when: spec("ui", "+Y") },

    ...SECTION_CELLS.flatMap((cells, index) => [
      { cell: cells.static, when: (c: FormContext) => sections(c)[index]?.surface === "static" },
      { cell: cells.conveyor, when: (c: FormContext) => sections(c)[index]?.surface === "conveyor" },
    ]),

    { cell: "D56", when: (c) => /Syncronisation/i.test(c.item.optionCodes.join("|")), covers: /Syncronisation/i },
    { cell: "D59", when: (c) => Boolean(c.item.spec.rollFeed) },
    { cell: "D69", when: (c) => c.item.spec.paperRollHolder === true },
    { cell: "D71", when: (c) => c.item.spec.crate === true },
  ],
};
```

- [ ] **Step 5: Write the FabricPro spec**

Create `src/lib/production-forms/specs/fabricpro.ts`. Coordinates come from spec §5.3.

```ts
import { fabricProSpecSchema } from "@/lib/validation/production-spec";
import type { FormContext, FormSpec } from "../types";

/** FP-TROLLEY is deliberately excluded: it has its own form, out of scope. */
const CODE = /^FP-(180|220|300)$/;

const modelCell = (code: string) => ({ "FP-180": "H27", "FP-220": "J27", "FP-300": "M27" })[code];
const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

export const fabricProSpec: FormSpec = {
  id: "fabricpro",
  title: "Fabric Pro Order Form",
  template: "fabric-pro-order-form-08.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  matches: (code) => CODE.test(code),
  specSchema: fabricProSpecSchema,
  requires: ["ui"],

  values: [
    { cell: "G10", from: (c) => c.distributorName },
    { cell: "N10", from: (c) => c.authorName },
    { cell: "H15", from: (c) => c.company.name },
    { cell: "H16", from: (c) => c.company.addressLines[0] },
    { cell: "H17", from: (c) => c.company.addressLines[1] },
    { cell: "H18", from: (c) => c.contact.fullName },
    { cell: "H19", from: (c) => c.contact.position },
    { cell: "H20", from: (c) => c.contact.phone },
    { cell: "H22", from: (c) => c.contact.email },
    { cell: "H23", from: (c) => c.company.industry },
    { cell: "O15", from: (c) => c.deliveryAddressLines[0] },
    { cell: "O16", from: (c) => c.deliveryAddressLines[1] },
    { cell: "O17", from: (c) => c.deliveryAddressLines[2] },
    { cell: "N46", from: (c) => c.item.spec.railLengthM as number | undefined },
    { cell: "N48", from: (c) => c.item.spec.powerRailLengthM as number | undefined },
  ],

  replaces: [],

  ticks: [
    { cell: "H27", when: (c) => modelCell(c.item.code) === "H27" },
    { cell: "J27", when: (c) => modelCell(c.item.code) === "J27" },
    { cell: "M27", when: (c) => modelCell(c.item.code) === "M27" },

    // The form prints one voltage and notes it is the only one available.
    { cell: "H35", when: () => true },

    { cell: "J41", when: spec("ui", "-Y") },
    { cell: "O41", when: spec("ui", "+Y") },

    { cell: "J44", when: (c) => c.item.spec.travelPlatform === true },
    { cell: "J46", when: (c) => Boolean(c.item.spec.railLengthM) },
    { cell: "J48", when: (c) => Boolean(c.item.spec.powerRailLengthM) },

    { cell: "D58", when: (c) => c.item.spec.exWorks === true },
    { cell: "D68", when: (c) => c.item.spec.crate === true },
  ],
};
```

- [ ] **Step 6: Register both**

Replace `src/lib/production-forms/specs/index.ts`:

```ts
import type { FormSpec } from "../types";
import { mSeriesSpec } from "./m-series";
import { easyLoaderSpec } from "./easyloader";
import { fabricProSpec } from "./fabricpro";

/** Order is irrelevant: matching is by product code and pages follow item sortOrder. */
export const FORM_SPECS: FormSpec[] = [mSeriesSpec, easyLoaderSpec, fabricProSpec];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/production-forms-resolve.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 8: Commit**

```bash
git add src/lib/production-forms/specs src/lib/production-forms/templates tests/production-forms-resolve.test.ts
git commit -m "feat: EasyLoader and FabricPro form specs"
```

---

## Task 14: Rendering and the API route

**Files:**
- Create: `src/lib/production-forms/render.ts`
- Create: `src/components/sheet/additional-items-sheet.tsx`
- Create: `src/app/api/documents/[documentId]/production-forms/route.ts`
- Modify: `src/lib/queries/documents.ts`

- [ ] **Step 1: Add the query**

In `src/lib/queries/documents.ts`, add beside the existing builder query:

```ts
export const productionFormsInclude = {
  region: true,
  // `select`, not `true`: `author: true` pulls the whole User row --
  // passwordHash included -- into a payload that flows on to the renderer.
  // The forms print one field, the salesperson's name.
  author: { select: { name: true } },
  company: { include: { industry: true } },
  contact: true,
  items: { orderBy: { sortOrder: "asc" }, include: { lines: true } },
  lines: { where: { itemId: null } },
} satisfies Prisma.DocumentInclude;

export type DocumentForForms = Prisma.DocumentGetPayload<{ include: typeof productionFormsInclude }>;

/**
 * A document loaded for production form rendering, scoped to the caller the
 * same way `getDocumentForBuilder` is.
 */
export async function getDocumentForForms(user: SessionUser, documentId: string) {
  return db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(user) },
    include: productionFormsInclude,
  });
}
```

Then update `src/lib/production-forms/context.ts` to import `DocumentForForms` from here instead of its local type.

- [ ] **Step 2: Write the renderer**

Create `src/lib/production-forms/render.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

const GOTENBERG_TIMEOUT_MS = 60_000;

function gotenbergUrl(): string {
  const baseUrl = process.env.GOTENBERG_URL;
  if (!baseUrl) throw new Error("GOTENBERG_URL is not configured");
  return baseUrl;
}

async function postToGotenberg(route: string, form: FormData): Promise<Buffer> {
  const response = await fetch(`${gotenbergUrl()}${route}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(GOTENBERG_TIMEOUT_MS),
  });

  if (!response.ok) {
    const snippet = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Gotenberg returned ${response.status}: ${snippet}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Templates are committed beside the specs and read straight off disk. */
export function readTemplate(name: string): Uint8Array {
  const file = path.join(process.cwd(), "src/lib/production-forms/templates", name);
  return new Uint8Array(readFileSync(file));
}

/**
 * Converts a patched workbook to PDF. LibreOffice honours the template's own
 * print settings -- A4 portrait, an explicit print area, fitToPage -- so the
 * one-page-per-form guarantee comes from the template rather than from us.
 */
export async function xlsxToPdf(xlsx: Uint8Array, filename: string): Promise<Buffer> {
  const form = new FormData();
  form.set("files", new Blob([xlsx as BlobPart]), filename);
  return postToGotenberg("/forms/libreoffice/convert", form);
}

/** Concatenates PDFs in the order given. */
export async function mergePdfs(pdfs: Buffer[]): Promise<Buffer> {
  if (pdfs.length === 1) return pdfs[0];

  const form = new FormData();
  pdfs.forEach((pdf, index) => {
    // Gotenberg merges in lexical filename order, so the index is zero-padded.
    form.append("files", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      `${String(index).padStart(3, "0")}.pdf`);
  });
  return postToGotenberg("/forms/pdfengines/merge", form);
}
```

- [ ] **Step 3: Write the Additional items sheet**

Create `src/components/sheet/additional-items-sheet.tsx`. Read `src/components/sheet/document-sheet.tsx` first and reuse its typography classes.

```tsx
export type AdditionalItem = {
  name: string;
  qty: number;
  description: string | null;
  /** Which machine this came from, or null for a document-level line. */
  source: string | null;
};

type Props = { documentNumber: string; companyName: string; items: AdditionalItem[] };

/**
 * Everything the machine forms deliberately do not carry: services, training,
 * custom entries, and any option this machine's form has no box for. One
 * sheet at the back rather than one after each form -- the workshop hands
 * forms out per machine, and a page stapled between two forms travels with
 * the wrong one. The machine form stays purely about what gets built;
 * nothing is silently dropped.
 */
export function AdditionalItemsSheet({ documentNumber, companyName, items }: Props) {
  return (
    <div className="pq-content">
      <h1>Additional items</h1>
      <p>
        {documentNumber} — {companyName}
      </p>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>From</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>{item.name}</td>
              <td>{item.qty}</td>
              <td>{item.source ?? "—"}</td>
              <td>{item.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Not part of any production form. For office reference only.</p>
    </div>
  );
}
```

- [ ] **Step 4: Write the route**

Create `src/app/api/documents/[documentId]/production-forms/route.ts`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import { getDocumentForForms } from "@/lib/queries/documents";
import { htmlToPdf } from "@/lib/pdf";
import { buildFormContexts } from "@/lib/production-forms/context";
import {
  buildPatches,
  missingRequirements,
  resolveForm,
  unmatchedOptionCodes,
} from "@/lib/production-forms/resolve";
import { patchWorkbook } from "@/lib/production-forms/xlsx-patch";
import { mergePdfs, readTemplate, xlsxToPdf } from "@/lib/production-forms/render";
import { AdditionalItemsSheet, type AdditionalItem } from "@/components/sheet/additional-items-sheet";

export const runtime = "nodejs";

type Params = { documentId: string };

/**
 * Streams the production forms for a finalized quote as one PDF, one A4 page
 * per machine. `?item=<itemId>` narrows it to a single form.
 *
 * FINAL quotes only: a draft is still being reworked, and the workshop must
 * not receive a form for a machine whose options are about to change.
 */
export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { documentId } = await params;
  const document = await getDocumentForForms(session.user, documentId);
  if (!document) return Response.json({ error: "Not found" }, { status: 404 });

  if (document.type !== "QUOTE" || document.status !== "FINAL") {
    return Response.json({ error: "Production forms require a finalized quote" }, { status: 409 });
  }

  const onlyItemId = new URL(request.url).searchParams.get("item");
  const contexts = buildFormContexts(document).filter(
    (ctx) => !onlyItemId || ctx.item.id === onlyItemId,
  );

  if (contexts.length === 0) {
    return Response.json({ error: "No production forms apply to this quote" }, { status: 404 });
  }

  const blockers = contexts.flatMap((ctx) => {
    const spec = resolveForm(ctx.item.code)!;
    const missing = missingRequirements(spec, ctx.item.spec);
    return missing.length ? [{ itemId: ctx.item.id, code: ctx.item.code, missing }] : [];
  });

  if (blockers.length > 0) {
    return Response.json({ error: "Production details are incomplete", blockers }, { status: 422 });
  }

  const pdfs: Buffer[] = [];

  try {
    for (const ctx of contexts) {
      const spec = resolveForm(ctx.item.code)!;
      const patched = patchWorkbook(
        readTemplate(spec.template),
        spec.sheetPath,
        buildPatches(spec, ctx),
      );
      pdfs.push(await xlsxToPdf(patched, `${spec.id}.xlsx`));
    }

    // Document-level lines, plus every option whose machine's form has no box
    // for it. The second half is the important one: without it an option
    // would reach neither the form nor the workshop.
    const extras: AdditionalItem[] = [
      ...document.lines.map((line) => ({
        name: line.name,
        qty: line.qty,
        description: line.description,
        source: null,
      })),
      ...contexts.flatMap((ctx) => {
        const spec = resolveForm(ctx.item.code)!;
        const item = document.items.find((row) => row.id === ctx.item.id);
        return unmatchedOptionCodes(spec, ctx).map((code) => {
          const line = item?.lines.find((row) => row.code === code);
          return {
            name: line?.name ?? code,
            qty: line?.qty ?? 1,
            description: line?.description ?? null,
            source: `${ctx.item.code} — ${ctx.item.name}`,
          };
        });
      }),
    ];

    if (extras.length > 0 && !onlyItemId) {
      const body = renderToStaticMarkup(
        AdditionalItemsSheet({
          documentNumber: document.number ?? "",
          companyName: document.company?.name ?? "",
          items: extras,
        }),
      );
      pdfs.push(
        await htmlToPdf(
          `<!doctype html><html><head><meta charSet="utf-8"><style>@page{size:A4;margin:15mm}body{margin:0}</style></head><body>${body}</body></html>`,
        ),
      );
    }
  } catch (error) {
    console.error("Production form generation failed", error);
    return Response.json({ error: "PDF service unavailable" }, { status: 502 });
  }

  const merged = await mergePdfs(pdfs);
  const filename = `${document.number ?? document.id}-production-forms.pdf`;

  return new Response(new Uint8Array(merged), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
```

Note: `renderToStaticMarkup` is imported statically here, unlike in `src/lib/pdf.ts`. If `next build` rejects it (read the comment at the top of `src/lib/pdf.ts` — it explains exactly this failure), switch to the same dynamic `await import("react-dom/server")` pattern that file uses.

- [ ] **Step 5: Verify end to end**

```bash
docker compose up -d postgres gotenberg
npm run dev
```

Create a quote with an M-Series machine, fill its production spec, finalize it, then:

```bash
curl -sS -b "<your session cookie>" \
  "http://localhost:3100/api/documents/<id>/production-forms" -o /tmp/forms.pdf
pdfinfo /tmp/forms.pdf | grep Pages
```

Expected: `Pages: 1`. Open it and confirm the ticks match what the quote holds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/production-forms/render.ts src/components/sheet/additional-items-sheet.tsx \
  "src/app/api/documents/[documentId]/production-forms/route.ts" src/lib/queries/documents.ts \
  src/lib/production-forms/context.ts
git commit -m "feat: render production forms to a merged PDF"
```

---

## Task 15: Spec contract test

**Files:**
- Test: `tests/production-forms-contract.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/production-forms-contract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { FORM_SPECS } from "../src/lib/production-forms/specs";

const TEMPLATE_DIR = path.resolve(__dirname, "../src/lib/production-forms/templates");

function loadSheet(template: string) {
  const workbook = XLSX.read(readFileSync(path.join(TEMPLATE_DIR, template)), { type: "buffer" });
  return workbook.Sheets[workbook.SheetNames[0]];
}

/**
 * Guards the two dangerous typos: a tick aimed one row off into a cell that
 * holds a printed label, and a value aimed at a label instead of the blank
 * beside it. Border checking is not possible with SheetJS -- box coordinates
 * are confirmed visually when each spec is first written (see spec 11).
 */
describe.each(FORM_SPECS.map((spec) => [spec.id, spec] as const))("%s form spec", (_id, spec) => {
  it("has its template committed", () => {
    expect(existsSync(path.join(TEMPLATE_DIR, spec.template))).toBe(true);
  });

  it("declares a worksheet path that exists in the archive", () => {
    const workbook = XLSX.read(readFileSync(path.join(TEMPLATE_DIR, spec.template)), { type: "buffer" });
    expect(workbook.SheetNames.length).toBeGreaterThan(0);
    expect(spec.sheetPath).toMatch(/^xl\/worksheets\/sheet\d+\.xml$/);
  });

  it("writes values only into blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.values) {
      expect(sheet[cell]?.v, `${spec.id} values cell ${cell} is not blank`).toBeUndefined();
    }
  });

  it("ticks only blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.ticks) {
      expect(sheet[cell]?.v, `${spec.id} tick cell ${cell} is not blank`).toBeUndefined();
    }
  });

  it("replaces only non-blank cells", () => {
    const sheet = loadSheet(spec.template);
    for (const { cell } of spec.replaces) {
      expect(sheet[cell]?.v, `${spec.id} replaces cell ${cell} is blank`).toBeDefined();
    }
  });

  it("uses no cell twice", () => {
    const cells = [...spec.values, ...spec.ticks, ...spec.replaces].map((entry) => entry.cell);
    expect(new Set(cells).size, `${spec.id} declares a cell more than once`).toBe(cells.length);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/production-forms-contract.test.ts`

Any failure is a real coordinate error, not a test problem. Correct the spec file against the template — reopen the xlsx and check which cell actually holds the label versus the blank beside it. Only after fixing every failure move on.

- [ ] **Step 3: Commit**

```bash
git add tests/production-forms-contract.test.ts
git commit -m "test: contract test pinning every form spec to its template"
```

---

## Task 16: Builder and document page UI

**Files:**
- Create: `src/components/builder/production-spec-editor.tsx`
- Create: `src/components/documents/production-forms-section.tsx`
- Modify: `src/components/builder/items-list.tsx`
- Modify: `src/app/(app)/documents/[documentId]/page.tsx`

- [ ] **Step 1: Write the production spec editor**

Create `src/components/builder/production-spec-editor.tsx`. Read `src/components/builder/item-options-editor.tsx` first and match its autosave and layout conventions.

```tsx
"use client";

import { useState } from "react";
import { setItemLineGroup, setProductionSpec } from "@/lib/actions/production";
import { resolveForm } from "@/lib/production-forms/resolve";

type Props = {
  itemId: string;
  itemCode: string;
  lineGroup: number;
  spec: Record<string, unknown>;
  /** Show the line chip only when the document holds more than one machine. */
  showLineChip: boolean;
};

const SCREEN_SIDES = ["+Y", "-Y"] as const;
const KNIFE_SIZES = ["1.5x5.0", "1.5x7.0", "2.0x7.0"] as const;
const VOLTAGES = ["220V", "400V", "415V", "480V"] as const;

export function ProductionSpecEditor({ itemId, itemCode, lineGroup, spec, showLineChip }: Props) {
  const form = resolveForm(itemCode);
  const [draft, setDraft] = useState(spec);
  const [error, setError] = useState<string | null>(null);

  if (!form) return null;

  async function save(next: Record<string, unknown>) {
    setDraft(next);
    const result = await setProductionSpec(itemId, next);
    setError(result.error ?? null);
  }

  const missing = form.requires.filter((key) => draft[key] === undefined);

  return (
    <details className="rounded border p-2">
      <summary>
        Production spec
        {missing.length > 0 && <span className="ml-2 text-amber-600">missing: {missing.join(", ")}</span>}
      </summary>

      <div className="mt-2 flex flex-col gap-2">
        {showLineChip && (
          <label>
            Line
            <select
              value={lineGroup}
              onChange={(e) => setItemLineGroup(itemId, Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          Operator screen side
          <select
            value={(draft.ui as string) ?? ""}
            onChange={(e) => save({ ...draft, ui: e.target.value })}
          >
            <option value="">—</option>
            {SCREEN_SIDES.map((side) => (
              <option key={side} value={side}>
                {side}
              </option>
            ))}
          </select>
        </label>

        {form.id === "m-series" && (
          <>
            <label>
              Knife size
              <select
                value={(draft.knifeSize as string) ?? ""}
                onChange={(e) => save({ ...draft, knifeSize: e.target.value })}
              >
                <option value="">—</option>
                {KNIFE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Voltage
              <select
                value={(draft.voltage as string) ?? ""}
                onChange={(e) =>
                  save({ ...draft, voltage: e.target.value === "" ? undefined : e.target.value })
                }
              >
                <option value="">—</option>
                {VOLTAGES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>

            <fieldset>
              <legend>Drills</legend>
              <label>
                <input
                  type="checkbox"
                  checked={(draft.drills as { required?: boolean })?.required ?? false}
                  onChange={(e) =>
                    save({ ...draft, drills: { required: e.target.checked, detail: "" } })
                  }
                />
                Drills required
              </label>
              {(draft.drills as { required?: boolean })?.required && (
                <input
                  type="text"
                  placeholder="Qty, type and size"
                  maxLength={22}
                  defaultValue={(draft.drills as { detail?: string })?.detail ?? ""}
                  onBlur={(e) =>
                    save({ ...draft, drills: { required: true, detail: e.target.value } })
                  }
                />
              )}
            </fieldset>

            <label>
              Special notes
              <input
                type="text"
                maxLength={28}
                defaultValue={(draft.specialNotes as string) ?? ""}
                onBlur={(e) => save({ ...draft, specialNotes: e.target.value })}
              />
            </label>
          </>
        )}

        {form.id === "easyloader" && (
          <>
            <label>
              Used as
              <select
                value={(draft.usage as string) ?? ""}
                onChange={(e) => save({ ...draft, usage: e.target.value })}
              >
                <option value="">—</option>
                <option value="onload">On load</option>
                <option value="offload">Off load</option>
              </select>
            </label>

            {!["EL-2020", "EL-2420"].includes(itemCode) && (
              <label>
                Custom width (mm)
                <input
                  type="number"
                  min={1}
                  max={9999}
                  defaultValue={(draft.customWidthMm as number) ?? ""}
                  onBlur={(e) =>
                    save({
                      ...draft,
                      customWidthMm: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
              </label>
            )}

            <fieldset>
              <legend>Table sections</legend>
              {[0, 1, 2].map((index) => {
                const sections = (draft.sections as Section[] | undefined) ?? [];
                const section = sections[index];
                return (
                  <div key={index}>
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      placeholder={`Section ${index + 1} length (m)`}
                      defaultValue={section?.lengthM ?? ""}
                      onBlur={(e) =>
                        save({
                          ...draft,
                          sections: writeSection(sections, index, {
                            lengthM: Number(e.target.value),
                            surface: section?.surface ?? "static",
                          }),
                        })
                      }
                    />
                    <select
                      value={section?.surface ?? "static"}
                      disabled={!section}
                      onChange={(e) =>
                        save({
                          ...draft,
                          sections: writeSection(sections, index, {
                            lengthM: section?.lengthM ?? 0,
                            surface: e.target.value as Section["surface"],
                          }),
                        })
                      }
                    >
                      <option value="static">Static</option>
                      <option value="conveyor">Conveyor</option>
                    </select>
                  </div>
                );
              })}
            </fieldset>

            <label>
              <input
                type="checkbox"
                checked={(draft.paperRollHolder as boolean) ?? false}
                onChange={(e) => save({ ...draft, paperRollHolder: e.target.checked })}
              />
              Perforated paper roll holder
            </label>

            <label>
              <input
                type="checkbox"
                checked={(draft.crate as boolean) ?? false}
                onChange={(e) => save({ ...draft, crate: e.target.checked })}
              />
              Crate required
            </label>
          </>
        )}

        {form.id === "fabricpro" && (
          <>
            <label>
              <input
                type="checkbox"
                checked={(draft.travelPlatform as boolean) ?? false}
                onChange={(e) => save({ ...draft, travelPlatform: e.target.checked })}
              />
              Travel platform
            </label>

            <label>
              Travel platform rail length (m)
              <input
                type="number"
                step="0.1"
                min={0}
                defaultValue={(draft.railLengthM as number) ?? ""}
                onBlur={(e) =>
                  save({
                    ...draft,
                    railLengthM: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
            </label>

            <label>
              Electrical power rail length (m)
              <input
                type="number"
                step="0.1"
                min={0}
                defaultValue={(draft.powerRailLengthM as number) ?? ""}
                onBlur={(e) =>
                  save({
                    ...draft,
                    powerRailLengthM: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
            </label>

            <label>
              <input
                type="checkbox"
                checked={(draft.exWorks as boolean) ?? false}
                onChange={(e) => save({ ...draft, exWorks: e.target.checked })}
              />
              Ex-Works
            </label>

            <label>
              <input
                type="checkbox"
                checked={(draft.crate as boolean) ?? false}
                onChange={(e) => save({ ...draft, crate: e.target.checked })}
              />
              Crate required
            </label>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </details>
  );
}
```

Add these two helpers at the top of the same file, above the component:

```tsx
type Section = { lengthM: number; surface: "static" | "conveyor" };

/**
 * Replaces one table section, dropping any trailing section left with no
 * length. The form prints three section rows and the schema caps the array
 * at three, so a cleared section must shrink the array rather than leave a
 * zero-length hole the renderer would tick a surface box for.
 */
function writeSection(sections: Section[], index: number, next: Section): Section[] {
  const copy = [...sections];
  copy[index] = next;
  while (copy.length > 0 && !copy[copy.length - 1]?.lengthM) copy.pop();
  return copy.filter(Boolean);
}
```

- [ ] **Step 2: Mount it in the item card**

In `src/components/builder/items-list.tsx`, below the existing options editor inside each item card:

```tsx
import { resolveForm } from "@/lib/production-forms/resolve";
import { ProductionSpecEditor } from "@/components/builder/production-spec-editor";

// once, above the item map -- the chip is noise on a single-machine quote
const machineCount = items.filter((item) => resolveForm(item.code) !== null).length;

// inside the item card, after the options editor
<ProductionSpecEditor
  itemId={item.id}
  itemCode={item.code}
  lineGroup={item.lineGroup}
  spec={(item.productionSpec ?? {}) as Record<string, unknown>}
  showLineChip={machineCount > 1}
/>
```

`ProductionSpecEditor` returns `null` for an item with no form, so software and service rows are unaffected.

- [ ] **Step 3: Write the forms section**

Create `src/components/documents/production-forms-section.tsx`:

```tsx
import Link from "next/link";
import { buildFormContexts } from "@/lib/production-forms/context";
import { missingRequirements, resolveForm, unmatchedOptionCodes } from "@/lib/production-forms/resolve";
import type { DocumentForForms } from "@/lib/queries/documents";

/**
 * Readiness list plus the download buttons. Rendered on FINAL quotes only --
 * the route enforces the same rule, so the UI and the server cannot disagree.
 */
export function ProductionFormsSection({ document }: { document: DocumentForForms }) {
  if (document.type !== "QUOTE" || document.status !== "FINAL") return null;

  const contexts = buildFormContexts(document);
  if (contexts.length === 0) {
    return <p>No production forms apply to this quote.</p>;
  }

  const rows = contexts.map((ctx) => {
    const spec = resolveForm(ctx.item.code)!;
    return { ctx, spec, missing: missingRequirements(spec, ctx.item.spec) };
  });

  const blocked = rows.some((row) => row.missing.length > 0);

  // Same arithmetic as the route: document-level lines plus every option no
  // form has a box for. Counting it differently here would let the button
  // promise a page count the PDF does not deliver.
  const extras =
    document.lines.length +
    rows.reduce((total, row) => total + unmatchedOptionCodes(row.spec, row.ctx).length, 0);

  const modulesWithoutHost =
    contexts[0].softwareCodes.some((code) => ["PDG", "WPN", "WPL", "ANT-V5", "ANT-V6"].includes(code)) &&
    !contexts[0].softwareCodes.some((code) => code === "PTW(I)" || code === "PTW(S)");

  return (
    <section>
      <h2>Production forms</h2>

      {modulesWithoutHost && (
        <p className="text-amber-600">
          PathWorks modules are on this quote with no PathWorks licence to host them.
        </p>
      )}

      <ul>
        {rows.map(({ ctx, spec, missing }) => (
          <li key={ctx.item.id}>
            <span>
              {spec.title} — {ctx.item.code}
            </span>
            {missing.length === 0 ? (
              <Link href={`/api/documents/${document.id}/production-forms?item=${ctx.item.id}`}>
                PDF
              </Link>
            ) : (
              <span className="text-amber-600">missing: {missing.join(", ")}</span>
            )}
          </li>
        ))}
        {extras > 0 && <li>Additional items ({extras})</li>}
      </ul>

      {blocked ? (
        <button type="button" disabled>
          Download all forms
        </button>
      ) : (
        <Link href={`/api/documents/${document.id}/production-forms`}>
          Download all forms ({rows.length + (extras > 0 ? 1 : 0)} pages)
        </Link>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Mount it on the document page**

In `src/app/(app)/documents/[documentId]/page.tsx`:

```tsx
import { getDocumentForForms } from "@/lib/queries/documents";
import { ProductionFormsSection } from "@/components/documents/production-forms-section";

// alongside the existing document load
const formsDocument = await getDocumentForForms(session.user, documentId);

// below the existing document actions
{formsDocument && <ProductionFormsSection document={formsDocument} />}
```

The component returns `null` for anything that is not a FINAL quote, so no status check is needed at the call site.

- [ ] **Step 5: Verify end to end**

```bash
npm run dev
```

Build a quote with M-Series + EasyLoader + FabricPro. Confirm:

1. Before filling any production spec, every row shows its missing keys and the download button is disabled.
2. Setting `+Y` on the M-Series toast-confirms it also applied to the EasyLoader and FabricPro (same line).
3. Setting line 2 on one machine and then changing its side leaves line 1's machines untouched.
4. With everything filled, the download yields a 3-page PDF with correct ticks.
5. Adding a custom line adds a fourth "Additional items" page.

- [ ] **Step 6: Run the whole suite and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/components/builder/production-spec-editor.tsx \
  src/components/documents/production-forms-section.tsx \
  src/components/builder/items-list.tsx \
  "src/app/(app)/documents/[documentId]/page.tsx"
git commit -m "feat: production spec editor and forms download section"
```

---

## Task 17: Pipeline golden test

**Files:**
- Test: `tests/production-forms-pipeline.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/production-forms-pipeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildPatches, resolveForm } from "../src/lib/production-forms/resolve";
import { patchWorkbook } from "../src/lib/production-forms/xlsx-patch";
import { readTemplate } from "../src/lib/production-forms/render";
import type { FormContext } from "../src/lib/production-forms/types";

const ctx: FormContext = {
  distributorName: "Pathfinder Australia Pty Ltd",
  authorName: "Vadym H",
  company: {
    name: "Relaxvanguard",
    addressLines: ["12 Industrial Drive", "Dandenong South VIC 3175"],
    industry: "Automotive",
  },
  contact: { fullName: "John Smith", position: "Manager", phone: "+61 3 9999 0000", email: "j@e.com" },
  deliveryAddressLines: ["12 Industrial Drive"],
  softwareCodes: ["PTW(I)", "ANT-V6"],
  item: {
    id: "item1",
    code: "M5220",
    name: "M-Series",
    lineGroup: 1,
    spec: { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "2 x 6mm" } },
    optionCodes: ["MTS", "ABR-M"],
    optionAttributes: { MTS: { metres: 14 } },
  },
};

describe("production form pipeline", () => {
  it("produces a workbook carrying every expected value and tick", () => {
    const spec = resolveForm("M5220")!;
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    expect(xml).toContain("Pathfinder Australia Pty Ltd");
    expect(xml).toContain("Relaxvanguard");
    expect(xml).toContain("Automotive");
    expect(xml).toContain("2 x 6mm");
    expect(xml).toContain("14");

    for (const cell of ["J25", "J29", "J33", "J52", "F68", "D72", "J64"]) {
      expect(xml, `expected a tick in ${cell}`).toMatch(
        new RegExp(`<c r="${cell}"[^>]*t="inlineStr"><is><t[^>]*>X</t>`),
      );
    }
  });

  it("leaves untouched every box the quote did not ask for", () => {
    const spec = resolveForm("M5220")!;
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    // H25 is model M3, O25 is M10 -- neither was ordered.
    for (const cell of ["H25", "O25", "L25"]) {
      expect(xml).not.toMatch(new RegExp(`<c r="${cell}"[^>]*t="inlineStr"`));
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/production-forms-pipeline.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 3: Run the whole suite**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/production-forms-pipeline.test.ts
git commit -m "test: end-to-end production form patching golden test"
```

---

## Done

At this point a finalized quote with M-Series, EasyLoader and FabricPro produces one PDF with three A4 pages, each a faithful copy of the form production already knows, with every derivable box ticked.

Adding one of the remaining ten forms is: copy the xlsx into `templates/`, write a spec file, register it in `specs/index.ts`, extend the resolve tests, run the contract test, and check one printed page by eye.
