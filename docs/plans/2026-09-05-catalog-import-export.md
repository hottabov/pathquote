# Catalog import / export — implementation plan

Date: 2026-09-05. Backlog: John/Wayne #17, Ross/Martin #12 (both sized **M**).

Owner decisions taken 2026-09-05:

- **Rows missing from an uploaded file are deleted from the catalogue**, with confirmation.
  Finalized quotes are left untouched. Non-finalized quotes lose the line too. Admin-only,
  global action.
- **Three sheets**: `Products`, `Options`, `Prices` (a price row = item × region).
- **Price versioning is out of v1** — effective dates and history come later.

Status: `[ ]` not started · `[~]` in progress · `[x]` done.

---

## 0. What the codebase already gives us, verified

Both checks below were run against the tree, not assumed.

**`DocumentItem` snapshots everything a quote needs to render**: `code`, `name`,
`description`, `unitPrice`, `listPrice`, `imageUrl` (`prisma/schema.prisma:576-593`).
So a finalized quote survives its product being deleted — nothing it prints is read
live. This is what makes the owner's "don't touch finalized quotes" rule cheap to honour.

**`code` coupling is narrower than the catalogue-v2 audit estimated.** That doc says
"~60 sites of application logic branch on its literal value"; the actual count is
**13 literals across 9 files**, plus **six mechanisms**:

| # | Mechanism | Where |
|---|---|---|
| 1 | Machine specs parsed out of the code digits (`M3390` → 3cm × 390cm) | `lib/machine-specs.ts` |
| 2 | EasyLoader derived option codes **constructed** as `` `${itemCode} ${suffix}` `` | `lib/production-forms/table-sections.ts:55` |
| 3 | Which production form a product gets | `production-forms/resolve.ts` |
| 4 | EasyLoader printed-width box picked by a code-keyed map | `production-forms/specs/easyloader.ts:121` |
| 5 | Content-block key derived from code | `lib/quotation-data.ts:177` |
| 6 | Hardcoded `["EL-2020", "EL-2420"]` | `components/builder/production-spec-editor.tsx:557` |

Mechanism 1 is a **deliberate domain rule**, not accidental coupling — its own comment
says the digits in the code are the source of truth and a catalogue description can be
wrong. Mechanism 2 is the dangerous one: rename an EasyLoader product and every derived
option code changes with it, so existing layouts stop matching.

**Conclusion that shapes v1:** matching import rows by `id` makes the *import mechanism*
safe today. What is not safe is letting the file change `code`. Those are separable, so
v1 ships with `code` read-only and full editing of everything else.

> **Superseded 2026-09-06.** All six mechanisms were removed by
> `docs/plans/2026-09-05-catalog-identity-and-cleanup.md` (phases 2 and 4): behaviour
> now keys on `Product.kind/form/specs/contentBlockKey` and
> `Option.role/parentProductId/unitLengthM/contentBlockKey`, and `code` is a mutable
> label. An import may therefore let the file change `code` (the old code goes to
> `legacyCodes`, as `scripts/lib/catalog-v2-plan.ts` does) — revisit the "code
> read-only" scoping below before building v1.

---

## 1. The trap: deletion cannot be left to the schema

`DocumentItem.product` is declared **without `onDelete`** (`schema.prisma:578`), so
Prisma's default for an optional relation applies: `SetNull`. Deleting a product
therefore does **not** raise an error and does **not** remove anything — it nulls the
link and leaves the item in place.

For a finalized quote that is exactly right (see §0). For a draft it is the worst
outcome available: a **phantom line** with a price, still counted in the total, pointing
at a product that no longer exists. Nobody wrote that behaviour down; it is a Prisma
default nobody chose.

`DocumentLine.refId` is worse: a plain `String`, not a foreign key
(`schema.prisma:626`), so deleting an **option** leaves lines referencing nothing at all,
with no database-level signal.

**So the import must own deletion explicitly:**

1. FINAL documents — touch nothing. Snapshots already make them correct.
2. DRAFT documents — delete the affected items and lines, then **recalculate each
   affected document**. This is the expensive and destructive part, and it reaches into
   drafts belonging to other users.
3. Make the intent explicit in the schema rather than relying on a default: an explicit
   `onDelete: SetNull` with a comment saying *why* (finalized quotes must survive), so the
   next reader sees a decision instead of an accident.

- [ ] **1.1** Migration: explicit `onDelete: SetNull` on `DocumentItem.product`, with the
  reasoning in a schema comment. No behaviour change — it writes down what already happens.

---

## 2. Export

- [ ] **2.1** `GET /api/catalog/export` (ADMIN only) → `.xlsx`, three sheets.
- [ ] **2.2** Column layout. Every sheet leads with `id` — that is the join key on import.
  It is deliberately not hidden: a hidden column that silently controls destructive
  behaviour is worse than a visible one nobody edits. Header row frozen and styled;
  read-only columns (`id`, `code`) visually marked and protected via sheet protection,
  which Excel honours as a warning rather than a lock — the import validates regardless.

  | Sheet | Columns |
  |---|---|
  | `Products` | `id`, `code` (ro), `series`, `name`, `description`, `partNumber`, `sortOrder`, `active`, `isCredit`, `noCommission` |
  | `Options` | `id`, `code` (ro), `name`, `description`, `partNumber`, `sortOrder`, `active`, `noCommission` |
  | `Prices` | `id` (price row), `itemId`, `itemType` (product\|option), `itemCode` (ro), `itemName` (ro), `regionCode`, `currency` (ro), `amount`, `needsReview` |

- [ ] **2.3** Build on `xlsx` (already a devDependency) — but it must move to
  `dependencies`, since this now runs in the app rather than in a script. Note its two
  open advisories (prototype pollution, ReDoS): both are parser-side and this route
  **reads** untrusted files at import, so this is a real consideration and not a
  formality. Evaluate `exceljs` as an alternative before committing to it; decide on
  evidence and record the decision here.
- [ ] **2.4** A round-trip test: export → parse → assert every catalogue row is present
  with the values the DB holds.

---

## 3. Import — preview first, write second

The backlog is explicit on both sides ("імпорт з попереднім переглядом змін",
"confirmation before write"), and the deletion rule makes it mandatory.

- [ ] **3.1** Upload → parse → **diff against the live catalogue**, computed and returned
  without writing anything. Diff shape: `unchanged | updated (field-by-field before→after)
  | new | missing`.
- [ ] **3.2** Preview screen: counts per bucket, a table of every change, and — for the
  `missing` bucket — for each row **how many DRAFT documents will lose a line** and
  **how many FINAL quotes reference it** (the latter shown as reassurance that they are
  not being touched). This is the number that makes the confirmation meaningful.
- [ ] **3.3** Validation, all reported as row/column errors rather than a single failure:
  unknown `id`, `code` edited (rejected in v1), negative price, unparseable number,
  unknown `regionCode`, duplicate row for the same item × region.
- [ ] **3.4** Apply, in **one transaction**: updates, inserts, then deletions with the
  draft cleanup from §1, then a recalc per affected draft. If the transaction is too large
  in practice, batch by document — but never leave a draft un-recalculated, since a stale
  total is money that is silently wrong.
- [ ] **3.5** Audit record: who, when, file name, counts per bucket, and the full diff.
  Without it a bad import cannot be reconstructed, and versioning (§6) will need this
  table anyway.
- [ ] **3.6** ADMIN only, on both the export and the import routes and in the UI.

---

## 4. Testing

The action layer has no automated coverage by design (the suite is pure-function, zero
Prisma mocks). So the diff engine must be **pure**: `(parsedRows, catalogueSnapshot) → diff`,
with no database access, and it carries the test weight.

- [ ] **4.1** Unit tests for the diff: every bucket, field-level updates, duplicate rows,
  unknown ids, a `code` edit, an empty file, a file with only headers.
- [ ] **4.2** Round-trip test (§2.4).
- [ ] **4.3** A test asserting a finalized quote's totals are **unchanged** after its
  product is deleted — the owner's rule, currently guaranteed only by snapshots that
  nobody has pinned down.

---

## 5. Out of v1, deliberately

- **Editing `code`** — gated on the six mechanisms in §0 moving to `id`/attributes
  (`docs/plans/2026-09-05-catalog-identity-and-cleanup.md`, Phase 1).
- **Price versioning / effective dates** — owner's call; separate schema work.
- **Nightly Google Sheets / M365 sync** (Ross/Martin #12 item 3) — needs v1 stable first.
- **Creating new regions from the file** — the `Prices` sheet references regions, it does
  not define them.

---

## 6. Open question for the owner

Ross set a constraint at the meeting: *"people have to have certainty, it can't be
fluctuating all the time"* — prices change monthly, not daily. v1 as planned applies an
import the moment it is confirmed, with no scheduling. Worth confirming that immediate
application is what is wanted, or whether an import should be stageable against a date
from the start (which would pull §5's versioning into v1).
