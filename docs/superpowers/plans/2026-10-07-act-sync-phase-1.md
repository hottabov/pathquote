# ACT! Sync Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull contacts and companies from the Act! Web API into PathQuote on a delta cursor, so a salesperson finds a client by typing three characters instead of retyping one.

**Architecture:** Everything that decides anything is a pure function in `src/lib/act/`, unit-tested with no network and no database — `vitest.config.ts` turns off isolation on the explicit promise that the suite has no mocks, no I/O and no DB, and this work must not be what breaks it. Around those sit two thin shells: a client that talks HTTP and a worker that talks Prisma, neither unit-tested, both small enough to read. Reads only; nothing is written back to ACT! in this phase.

**Tech Stack:** TypeScript, Next.js, Prisma/Postgres, vitest, `google-libphonenumber` (already a dependency), `tsx` for the CLI entry point.

**Specs:** `docs/superpowers/specs/2026-09-08-act-integration-design.md` (design), `docs/act-integration-reference.md` (verified field mappings, endpoints, infrastructure).

---

## File structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | modify — ACT! columns on `Company`, `Contact`, `User`; `ActSyncState` enum |
| `prisma/migrations/z60_act_sync/migration.sql` | create — the matching hand-written migration |
| `src/lib/act/types.ts` | create — the shape of what the API returns, and of what the mapper produces |
| `src/lib/act/company-key.ts` | create — company name normalisation and the name+country grouping key |
| `src/lib/act/phone.ts` | create — the three-step ladder from an ACT! phone string to E.164 |
| `src/lib/act/industries.ts` | create — `resolveActIndustry` moved out of `scripts/`, with the alias table indexed once |
| `src/lib/act/map.ts` | create — one ACT! contact to PathQuote contact and company shapes, plus the skip rules |
| `src/lib/act/merge.ts` | create — fill-only-empty, the single place that decides whether a sync may overwrite |
| `src/lib/act/client.ts` | create — HTTP: token caching, 401 retry, both envelope shapes, paging on `edited` |
| `src/lib/act/sync.ts` | create — orchestration: cursor in, pages through, upserts, cursor out |
| `scripts/act-sync.ts` | create — CLI entry; `--full`, `--dry-run`, `--limit` |
| `scripts/import-act-industries.ts` | modify — import the resolver from `src/lib/act/industries.ts` instead of defining it |
| `tests/act-company-key.test.ts` | create |
| `tests/act-phone.test.ts` | create |
| `tests/act-industries.test.ts` | create |
| `tests/act-map.test.ts` | create |
| `tests/act-merge.test.ts` | create |

`client.ts` and `sync.ts` hold no decisions worth testing in isolation — every judgement they would make lives in the pure modules above them. They are verified by running the thing against the real API in Task 11.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/z60_act_sync/migration.sql`

- [ ] **Step 1: Add the enum and columns to the schema**

In `prisma/schema.prisma`, next to the other enums:

```prisma
/// Where a PathQuote record stands against its ACT! counterpart.
/// Phase 1 only ever writes SYNCED. PENDING and CONFLICT exist now because the
/// spec fixes the state machine, so freezing all three here keeps phase 2 from
/// inventing a different vocabulary later -- not to avoid a migration, which
/// z56_el_install_role shows is a one-line file.
enum ActSyncState {
  SYNCED
  PENDING
  CONFLICT
}
```

In `model Company`, before `@@index([ownerId])`:

```prisma
  /// ACT! links only ~2.5% of contacts to a real Company record; for those,
  /// this holds that id. Null for the rest, whose company PathQuote derives
  /// from the contact's free-text company name -- see the spec's "Company is
  /// derived, not imported".
  actCompanyId       String?      @unique
  /// Normalised company name + ISO country. Unique because it IS the identity
  /// of a derived company, so the guarantee is only as strong as the
  /// normalisation in src/lib/act/company-key.ts.
  actCompanyKey      String?      @unique
  /// recordManagerID of whichever contact the sync happened to process last
  /// for this company. Last-writer-wins and not authoritative: a derived
  /// company can have contacts under several managers. Kept as a uuid rather
  /// than a name because names change, and intended as the hint that maps a
  /// company to a PathQuote owner via User.actUserId.
  actRecordManagerId String?
  /// ACT! idStatus, promoted out of the snapshot because the client list
  /// filters on it.
  actStatus          String?
  /// When this sync last touched the row. Distinct from the source record's
  /// own edited time, which a derived company does not have.
  actSyncedAt        DateTime?
```

In `model Contact`, before `@@index([companyId])`:

```prisma
  /// The ACT! contact this row mirrors. Null for contacts created in
  /// PathQuote and never matched to ACT!, and it is the authoritative answer
  /// to "does ACT! know about this contact?".
  actContactId      String?       @unique
  /// Null means the same thing actContactId null means: this contact has no
  /// ACT! counterpart. Set only alongside actContactId.
  actSyncState      ActSyncState?
  /// The `edited` timestamp ACT! reported for this contact at the last sync --
  /// the source record's own clock, not ours. actSyncedAt is when we ran.
  /// Phase 2 sends this back as a concurrency token; phase 1 only records it.
  actSourceEditedAt DateTime?
  /// When this sync last touched the row.
  actSyncedAt       DateTime?
  /// ACT! "Account Mgr" (customFields/rep). Visibility is decided on this,
  /// not on Record Manager -- see the spec's "Who sees what". Imported from
  /// day one so switching visibility on later is a filter, not a re-import.
  actAccountMgr     String?
```

In `model User`, after `active`:

```prisma
  /// ACT! user id, the join between an ACT! Record Manager and a PathQuote
  /// user. Null until someone maps them.
  actUserId         String?       @unique
  /// This user's name as it appears in ACT!'s "Account Mgr" field.
  actAccountMgr     String?
  /// Countries whose contacts this user may see, mirroring their ACT! Sync
  /// Set. ISO 3166-1 alpha-2, the same vocabulary as the country half of
  /// Company.actCompanyKey and as Company.country for rows written since the
  /// ISO migration -- legacy company rows may still hold free text, so a
  /// visibility filter cannot assume every row compares directly. Empty means
  /// "no country grant" -- they still see contacts
  /// where actAccountMgr matches them.
  visibleCountries  String[]      @default([])
```

No index on `actAccountMgr` yet. Nothing reads it in this phase, and the
visibility rule it would eventually serve is `actAccountMgr = me OR country IN
(...)` — an OR this index does not answer on its own. It also costs on every
write during a 12,000-row import. Add it with the query that needs it.

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/z60_act_sync/migration.sql`:

```sql
-- ACT! read-only sync, phase 1
-- (docs/superpowers/specs/2026-09-08-act-integration-design.md).
--
-- Additive only: new nullable columns, one enum, one table. No data is
-- modified -- there is no backfill, no UPDATE and no drop.
--
-- The ALTERs take ACCESS EXCLUSIVE on Company, Contact and User, which blocks
-- reads as well as writes and is held until the file commits, because Prisma
-- runs a migration as one transaction. The index builds run under that same
-- lock. Every column involved is NULL at that point so it is brief, but User
-- is read on each authenticated request -- whether that needs a window is the
-- approver's call, not this file's.

CREATE TYPE "ActSyncState" AS ENUM ('SYNCED', 'PENDING', 'CONFLICT');

ALTER TABLE "Company"
  ADD COLUMN "actCompanyId"       TEXT,
  ADD COLUMN "actCompanyKey"      TEXT,
  ADD COLUMN "actRecordManagerId" TEXT,
  ADD COLUMN "actStatus"          TEXT,
  ADD COLUMN "actSyncedAt"        TIMESTAMP(3);

ALTER TABLE "Contact"
  ADD COLUMN "actContactId"      TEXT,
  ADD COLUMN "actSyncState"      "ActSyncState",
  ADD COLUMN "actSourceEditedAt" TIMESTAMP(3),
  ADD COLUMN "actSyncedAt"       TIMESTAMP(3),
  ADD COLUMN "actAccountMgr"     TEXT;

ALTER TABLE "User"
  ADD COLUMN "actUserId"        TEXT,
  ADD COLUMN "actAccountMgr"    TEXT,
  -- No NOT NULL: this is what `prisma migrate diff` generates for a
  -- `String[] @default([])`, and CI compares the two.
  ADD COLUMN "visibleCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Unique rather than plain indexes: each of these IS an identity. Two
-- PathQuote companies claiming the same ACT! company, or the same derived
-- name+country key, is a bug that should fail on insert rather than quietly
-- split a client's quotes across two records.
CREATE UNIQUE INDEX "Company_actCompanyId_key"  ON "Company"("actCompanyId");
CREATE UNIQUE INDEX "Company_actCompanyKey_key" ON "Company"("actCompanyKey");
CREATE UNIQUE INDEX "Contact_actContactId_key"  ON "Contact"("actContactId");
CREATE UNIQUE INDEX "User_actUserId_key"        ON "User"("actUserId");

-- The ACT! payload sits in its own table so it is never selected alongside a
-- company name. One row per contact or company, never both, which Prisma
-- cannot express and a CHECK can.
CREATE TABLE "ActSnapshot" (
  "id"        TEXT  NOT NULL,
  "contactId" TEXT,
  "companyId" TEXT,
  "payload"   JSONB NOT NULL,

  CONSTRAINT "ActSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActSnapshot_one_owner" CHECK (
    ("contactId" IS NOT NULL) <> ("companyId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ActSnapshot_contactId_key" ON "ActSnapshot"("contactId");
CREATE UNIQUE INDEX "ActSnapshot_companyId_key" ON "ActSnapshot"("companyId");

ALTER TABLE "ActSnapshot"
  ADD CONSTRAINT "ActSnapshot_contactId_fkey" FOREIGN KEY ("contactId")
    REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ActSnapshot_companyId_fkey" FOREIGN KEY ("companyId")
    REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

`prisma migrate diff` will not generate the CHECK — Prisma has no syntax for
it. That is expected and is why these migrations are hand-written; CI compares
columns and indexes, not constraints.

The ACT! payload does **not** go on `Contact` or `Company`. Add a side table,
after the other models:

```prisma
/// The raw ACT! payload behind a synced record.
///
/// It lives here rather than as a column on Contact and Company because
/// Prisma selects every scalar unless told otherwise, and several existing
/// queries read whole rows with `include` rather than `select` --
/// src/lib/queries/documents-pickers.ts loads every visible company with all
/// of its contacts on each client-picker load. A full ACT! payload per row
/// would put tens of megabytes through that query.
///
/// A global Prisma `omit` was the other way to stop that, and it was tried and
/// rejected: `omit` changes the client's type parameter, so `PrismaClient`
/// stops being assignable to itself and the breakage lands in auth, recalc and
/// catalog code that has no interest in this column. Keeping the blob out of
/// the row needs no cleverness and cannot leak into a new query by default.
///
/// Phase 2 reads this to show a person what diverged under fill-only-empty;
/// phase 1 only writes it. Exactly one of contactId and companyId is set --
/// see the CHECK constraint in the migration.
///
/// Only a contact-owned row is a copy of one ACT! record. A company-owned row
/// holds the company fields as seen by the last contact the sync processed,
/// because a derived company has no ACT! record of its own -- the same
/// last-writer-wins caveat as Company.actRecordManagerId.
model ActSnapshot {
  id        String   @id @default(cuid())
  contactId String?  @unique
  companyId String?  @unique
  payload   Json
  contact   Contact? @relation(fields: [contactId], references: [id], onDelete: Cascade)
  company   Company? @relation(fields: [companyId], references: [id], onDelete: Cascade)
}
```

Add the back-relations: `actSnapshot ActSnapshot?` on both `model Contact` and
`model Company`.

- [ ] **Step 3: Check the schema parses and matches the migration**

Run: `npx prisma validate && npx prisma format --check`
Expected: `The schema at prisma/schema.prisma is valid`

Note: this sandbox has no Postgres, so `prisma migrate diff` cannot run here. CI runs it against a Postgres service container and fails if the schema and migrations disagree — see `docs/runbook.md`. A mismatch surfaces there.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Prisma's client is regenerated by `postinstall`; if `tsc` complains that the new fields do not exist on the model types, run `npx prisma generate` first.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/z60_act_sync/migration.sql
git commit -m "feat: ACT! sync columns on Company, Contact and User

Additive and nullable, so it applies to live data without a backup window.
The unique indexes are deliberate: two PathQuote companies claiming one ACT!
company would split a client's quotes in half, and that should fail on insert
rather than be discovered later.

Contact.actAccountMgr is imported from day one although nothing reads it yet.
Visibility is decided on Account Mgr, so having it from the first sync makes
switching visibility on a filter rather than a re-import."
```

---

### Task 2: Types

**Files:**
- Create: `src/lib/act/types.ts`

No test: this file declares types and no behaviour.

- [ ] **Step 1: Write the file**

```typescript
// The subset of the Act! Web API payloads this integration reads, and the
// PathQuote-shaped output the mapper produces.
//
// Field names here are the API's, which are NOT the names Act! shows a user:
// Industry is customFields/user6, Account Mgr is customFields/rep, and Stage
// lives in the stock messengerID field. See docs/act-integration-reference.md
// section 4 for the full table and resolve anything new through
// GET /api/metadata/contact/fields rather than guessing.

/** An address object as the API nests it under a contact or company. */
export type ActAddress = {
  line1: string | null;
  line2: string | null;
  line3: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

/** One contact, trimmed to the fields the sync reads. */
export type ActContact = {
  id: string;
  /** Empty string, not null, when the contact is linked to no company. */
  companyID: string | null;
  idStatus: string | null;
  contactType: string | null;
  isPrivate: boolean | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  emailAddress: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  /** Free text. For 97.5% of contacts this is the only company there is. */
  company: string | null;
  website: string | null;
  businessAddress: ActAddress | null;
  recordManagerID: string | null;
  recordManager: string | null;
  customFields: Record<string, string | number | boolean | null> | null;
  created: string;
  edited: string;
};

/** Custom-field keys the sync reads, by their API name. */
export const ACT_FIELD = {
  /** Displayed as "Industry". A renamed stock user slot. */
  industry: "user6",
  /** Displayed as "Account Mgr". Visibility is decided on this. */
  accountMgr: "rep",
} as const;

/** What the mapper produces for one contact. */
export type MappedContact = {
  actContactId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  /** E.164, or null when no spelling in the record could be resolved. */
  phone: string | null;
  position: string | null;
  actAccountMgr: string | null;
  actEditedAt: Date;
  snapshot: ActContact;
};

/** What the mapper produces for the company a contact belongs to. */
export type MappedCompany = {
  /** Null when the contact carries no company name at all. */
  actCompanyKey: string | null;
  /** Set only for the ~2.5% of contacts linked to a real ACT! company. */
  actCompanyId: string | null;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  /** ISO 3166-1 alpha-2, or null when the free-text country did not resolve. */
  country: string | null;
  website: string | null;
  /** A canonical industry segment name, or null. */
  industry: string | null;
  actStatus: string | null;
  actRecordManagerId: string | null;
};

/** One contact mapped, or the reason it was skipped. */
export type MapResult =
  | { kind: "mapped"; contact: MappedContact; company: MappedCompany }
  | { kind: "skipped"; reason: SkipReason };

export type SkipReason =
  | "not-a-contact"
  | "private"
  | "personal"
  | "inactive-status"
  | "no-name"
  /** Has a name but no company name. PathQuote's Contact requires a company,
   * so there is nothing to attach it to. Decided by the worker, not the
   * mapper. */
  | "no-company";

/** Statuses the sync imports. Everything else stays in ACT!. */
export const ACTIVE_STATUSES = [
  "Customer",
  "Prospect",
  "Prospect-Distributor",
  "Suspect",
] as const;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/act/types.ts
git commit -m "feat: types for the Act! payloads the sync reads

Field names are the API's, which are not the ones Act! shows a user: Industry
is customFields/user6 and Account Mgr is customFields/rep, because stock user
slots were renamed years ago. Guessing from a layout gets you a null column
and no error."
```

---

### Task 3: Company key

**Files:**
- Create: `src/lib/act/company-key.ts`
- Test: `tests/act-company-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/act-company-key.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normaliseCompanyName, companyKey } from "../src/lib/act/company-key";

describe("normaliseCompanyName", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normaliseCompanyName("  Acme   Cutting  ")).toBe("acme cutting");
  });

  it("strips legal suffixes", () => {
    expect(normaliseCompanyName("Acme Pty Ltd")).toBe("acme");
    expect(normaliseCompanyName("Acme GmbH")).toBe("acme");
    expect(normaliseCompanyName("Acme Inc.")).toBe("acme");
    expect(normaliseCompanyName("Acme Holdings")).toBe("acme");
  });

  it("collapses the spelling variants that differ only by punctuation", () => {
    expect(normaliseCompanyName("Efka America Inc.")).toBe(
      normaliseCompanyName("EFKA AMERICA, INC"),
    );
  });

  it("keeps ampersands, which distinguish real names", () => {
    expect(normaliseCompanyName("Norco Composites & GRP")).toBe("norco composites & grp");
  });

  it("does not strip a suffix that is the whole name", () => {
    // "Group" alone is a company name, not a suffix to discard.
    expect(normaliseCompanyName("Group")).toBe("group");
  });

  it("returns an empty string for junk", () => {
    expect(normaliseCompanyName("   ")).toBe("");
    expect(normaliseCompanyName("...")).toBe("");
  });
});

describe("companyKey", () => {
  it("joins the normalised name and the country code", () => {
    expect(companyKey("Acme Pty Ltd", "AU")).toBe("acme|AU");
  });

  it("separates the same name in different countries", () => {
    // adient genuinely has offices in five countries; a quote to Mexico is not
    // a quote to Romania.
    expect(companyKey("Adient", "MX")).not.toBe(companyKey("Adient", "RO"));
  });

  it("joins USA and United States once the country is already ISO", () => {
    expect(companyKey("Aaon", "US")).toBe(companyKey("AAON Inc", "US"));
  });

  it("uses a placeholder when the country did not resolve", () => {
    expect(companyKey("Acme", null)).toBe("acme|??");
  });

  it("returns null when there is no usable name", () => {
    expect(companyKey("", "AU")).toBeNull();
    expect(companyKey("   ", "AU")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-company-key.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/company-key"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/company-key.ts`:

```typescript
// Grouping contacts into companies.
//
// 12,088 of 12,094 active contacts carry a company name as free text and only
// 103 of the 9,622 distinct names match a real ACT! Company record, so the
// company a quote is addressed to is derived from this string. 85.8% of those
// names belong to exactly one contact, which means over-merging is the
// expensive mistake: two unrelated firms sharing a name become one client with
// one address.
//
// Country is therefore part of the key. 119 names (470 contacts) appear in
// more than one country, and while some of that is dirt that normalising the
// country already fixes, adient really does have offices in five.

/** Legal-form words that carry no identity. Order matters: the two-word forms
 * must be tried before the one-word forms, or "Pty Ltd" leaves a stray "pty". */
const LEGAL_SUFFIXES = [
  "pty ltd",
  "pty limited",
  "pty",
  "ltd",
  "limited",
  "llc",
  "l l c",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "gmbh",
  "ag",
  "bv",
  "nv",
  "sa",
  "srl",
  "spa",
  "ab",
  "oy",
  "as",
  "plc",
  "co",
  "company",
  "group",
  "holdings",
  "international",
  "intl",
];

/**
 * Fold a company name to its identity: lowercase, punctuation out, legal form
 * out, whitespace collapsed. Ampersands survive because they are part of real
 * names ("Norco Composites & GRP") rather than decoration.
 *
 * Returns an empty string when nothing identifying is left, which the caller
 * must treat as "no company" rather than as a group everyone falls into.
 */
export function normaliseCompanyName(raw: string): string {
  let s = (raw ?? "").toLowerCase();
  s = s.replace(/[^\p{L}\p{N}&\s-]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";

  // Strip suffixes from the end, repeatedly: "Acme Holdings Pty Ltd" sheds
  // three. Never strip the last remaining word, so a firm actually called
  // "Group" keeps its name.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) break;
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }

  return s.replace(/\s+/g, " ").trim();
}

/**
 * The identity of a derived company: normalised name and ISO country.
 *
 * `null` country becomes a literal `??` rather than being dropped, so
 * contacts whose country never resolved group together instead of silently
 * merging into whichever country happened to be first.
 *
 * Returns null when the name normalises to nothing — those contacts get no
 * company at all.
 */
export function companyKey(rawName: string, countryCode: string | null): string | null {
  const name = normaliseCompanyName(rawName);
  if (!name) return null;
  return `${name}|${countryCode ?? "??"}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-company-key.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/company-key.ts tests/act-company-key.test.ts
git commit -m "feat: derive a company identity from a contact's company name

85.8% of the 9,622 distinct company names belong to exactly one contact, so
over-merging is the expensive direction: two unrelated firms sharing a name
become one client with one delivery address.

Country is in the key for the same reason. 119 names appear in more than one
country; normalising the country fixes the USA/United States half of that, and
adient accounts for much of the rest with offices in five."
```

---

### Task 4: Phone ladder

**Files:**
- Create: `src/lib/act/phone.ts`
- Test: `tests/act-phone.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/act-phone.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { actPhoneToE164 } from "../src/lib/act/phone";

describe("actPhoneToE164", () => {
  it("parses a national number against the contact's own country", () => {
    expect(actPhoneToE164("03 94679176", "Australia")).toBe("+61394679176");
    expect(actPhoneToE164("770 928 3915", "United States")).toBe("+17709283915");
    expect(actPhoneToE164("(317) 271-1207", "United States")).toBe("+13172711207");
    expect(actPhoneToE164("0 1621 840 077", "United Kingdom")).toBe("+441621840077");
  });

  it("accepts an already-international number with no country at all", () => {
    expect(actPhoneToE164("+61 (3) 9338 3471", null)).toBe("+61393383471");
  });

  it("refuses a national number when the country is unknown", () => {
    // The same string is a different subscriber in a different country, and a
    // plausible wrong number on a signed quote is worse than a blank field.
    expect(actPhoneToE164("03 94679176", null)).toBeNull();
    expect(actPhoneToE164("770 928 3915", "Atlantis")).toBeNull();
  });

  it("does not guess when the number does not fit its stated country", () => {
    // 061 0759 9550 on a US contact is an Australian number with a stray zero.
    // Treating it as international would make it +60..., which is Malaysia.
    expect(actPhoneToE164("060 5286 3604", "United States")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(actPhoneToE164("", "Australia")).toBeNull();
    expect(actPhoneToE164("   ", "Australia")).toBeNull();
    expect(actPhoneToE164("\r", "Australia")).toBeNull();
    expect(actPhoneToE164("1234", "Australia")).toBeNull();
    expect(actPhoneToE164(null, "Australia")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-phone.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/phone"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/phone.ts`:

```typescript
import { validatePhone } from "@/lib/phone";
import { normalizeCountryInput } from "@/lib/countries";

// PathQuote stores E.164. ACT! stores twenty years of typing: "03 94679176",
// "(317) 271-1207", "0 1621 840 077".
//
// libphonenumber resolves all of those, but only when told which country to
// assume -- the same digits are a different subscriber elsewhere, and without
// a region it simply refuses. The region comes from each contact's own country
// field, which is populated on 97% of records.
//
// Measured over the 12,094 active contacts: 88.8% resolve, 3.4% are junk
// (fewer than five digits, stray carriage returns), and 7.8% have digits that
// do not fit the country stated on the record -- usually because the country
// is wrong, not the number.
//
// Recovery rules beyond this ladder were tried and rejected. Treating a failed
// number as an international one that lost its "+" recovers 102 contacts and
// gets some of them wrong: "060 5286 3604" on a US contact becomes +60..., in
// Malaysia. A plausible wrong number on a signed quote is worse than a blank
// field, so unresolved numbers stay null and the contact is flagged instead.

/** Fewer digits than this cannot be a phone number in any plan. */
const MIN_DIGITS = 5;

/**
 * One ACT! phone string to E.164, or null.
 *
 * `rawCountry` is the contact's own country as ACT! stores it -- free text
 * like "Australia" or "USA", resolved to ISO-2 here.
 */
export function actPhoneToE164(
  raw: string | null | undefined,
  rawCountry: string | null | undefined,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return null;

  // 1. Already international: the number carries its own country.
  if (trimmed.startsWith("+")) {
    const parsed = validatePhone(trimmed);
    return parsed.ok ? parsed.e164 : null;
  }

  // 2. National, read against the contact's own country.
  const region = normalizeCountryInput(rawCountry ?? null);
  if (!region) return null;

  const parsed = validatePhone(trimmed, region);
  return parsed.ok ? parsed.e164 : null;

  // 3. There is no step 3. See the note above on why.
}

/**
 * The contact's phone: the business number, falling back to the mobile when
 * there is no business number.
 *
 * Without the fallback 874 active contacts arrive with no number at all, which
 * is why PathQuote's single phone column reads two ACT! fields. It never
 * writes to either.
 */
export function contactPhone(
  businessPhone: string | null | undefined,
  mobilePhone: string | null | undefined,
  rawCountry: string | null | undefined,
): string | null {
  return (
    actPhoneToE164(businessPhone, rawCountry) ?? actPhoneToE164(mobilePhone, rawCountry)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-phone.test.ts`
Expected: PASS, 5 tests

If `actPhoneToE164("060 5286 3604", "United States")` returns a value rather than null, libphonenumber accepted it as a US number — change the fixture to another of the measured failures (`071 2252 1877`, `01577877024` against Germany) rather than weakening the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/phone.ts tests/act-phone.test.ts
git commit -m "feat: resolve ACT! phone numbers against each contact's own country

libphonenumber will not parse a national number without a region, and the
region has to come per-record: 88.8% of the 12,094 active contacts resolve
this way.

The ladder deliberately stops rather than guessing. Treating a failure as an
international number missing its plus recovers 102 contacts and corrupts some
of them -- 060 5286 3604 on a US contact becomes a Malaysian number. A
plausible wrong number on a signed quote is worse than an empty field."
```

---

### Task 5: Industry resolution

**Files:**
- Create: `src/lib/act/industries.ts`
- Modify: `scripts/import-act-industries.ts`
- Test: `tests/act-industries.test.ts`

The resolver already exists in `scripts/import-act-industries.ts`, whose own comment says the contact import "needs to resolve each contact's raw industry text against the same table this script seeded". Importing from `scripts/` into `src/` is backwards, and the existing implementation scans all 352 aliases per lookup — 12,000 contacts would be 4.2 million normalisations. It moves and gets an index.

- [ ] **Step 1: Write the failing test**

Create `tests/act-industries.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildIndustryResolver, loadActIndustries } from "../src/lib/act/industries";

describe("buildIndustryResolver", () => {
  const resolve = buildIndustryResolver();

  it("maps a known raw spelling to its canonical segment", () => {
    expect(resolve("Apparel")).toBe("Apparel");
    expect(resolve("Furniture")).toBe("Furniture & Upholstery");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolve("  apparel ")).toBe(resolve("Apparel"));
  });

  it("returns null for values that are not industries", () => {
    expect(resolve("NIL")).toBeNull();
  });

  it("returns null for an unknown spelling rather than inventing one", () => {
    // The importer must never create an industry row: free text is what
    // produced 335 spellings in the first place.
    expect(resolve("Underwater Basket Weaving")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolve(null)).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("   ")).toBeNull();
  });

  it("resolves every canonical segment to itself", () => {
    for (const name of loadActIndustries().canonical) {
      expect(resolve(name)).toBe(name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-industries.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/industries"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/industries.ts`:

```typescript
import actIndustries from "../../../scripts/data/act-industries.json";
import { normalizeIndustryName } from "@/lib/validation/industries";

// ACT!'s Industry field is free text and twenty years of it produced 335
// distinct spellings across 17,373 contacts -- "CARPET" and "carpET",
// "Leatrher & Skins", "BoatingBrunswick", and 307 rows of "NIL".
//
// scripts/data/act-industries.json is the cleaned mapping: 31 canonical trade
// segments and 352 raw spellings that point at them. It was built for
// scripts/import-act-industries.ts, which seeds the Industry table, and the
// sync resolves against the same table rather than inventing a second,
// dirtier one.
//
// The importer never creates an industry row. An unknown spelling leaves the
// company's industry unset and goes in the unresolved report, because
// auto-creating is exactly what produced 335 spellings.

export type ActIndustries = {
  /** The segments to seed. */
  canonical: string[];
  /** Raw ACT! spelling -> segment, or null for a value that is not an
   * industry. Also carries intermediate names from an earlier cleanup pass. */
  aliases: Record<string, string | null>;
};

/** Where the mapping lives, for error messages. Not used to read the file. */
export const ACT_INDUSTRIES_PATH = "scripts/data/act-industries.json";

/**
 * The mapping, as data.
 *
 * Imported statically rather than read with `readFileSync`: `resolveJsonModule`
 * is on, so this needs no filesystem at runtime and no assumption about the
 * working directory. The script this moved from used `import.meta.dirname`,
 * which does not survive Next's bundler, and `process.cwd()` would have made
 * the sync depend on being run from the repo root.
 */
export function loadActIndustries(): ActIndustries {
  return actIndustries as ActIndustries;
}

/**
 * A resolver from raw ACT! industry text to a canonical segment name, or null.
 *
 * The alias table is indexed once by normalised key. The previous
 * implementation scanned all 352 aliases per call, normalising both sides each
 * time; over 12,000 contacts that is 4.2 million normalisations to answer
 * 12,000 questions.
 */
export function buildIndustryResolver(
  data: ActIndustries = loadActIndustries(),
): (raw: string | null | undefined) => string | null {
  const index = new Map<string, string | null>();
  for (const [alias, segment] of Object.entries(data.aliases)) {
    index.set(normalizeIndustryName(alias), segment);
  }
  // Canonical names are not always present in the alias table; a segment must
  // always resolve to itself.
  for (const name of data.canonical) {
    index.set(normalizeIndustryName(name), name);
  }

  return (raw) => {
    if (!raw) return null;
    const key = normalizeIndustryName(raw);
    if (!key) return null;
    return index.get(key) ?? null;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-industries.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Point the seeding script at the moved resolver**

Three files import from the old location, so all three move with it.

**`scripts/import-act-industries.ts`.** Delete the local `ActIndustries` type,
`DATA_PATH`, `loadActIndustries` and `resolveActIndustry`, and the now-unused
`readFileSync` and `path` imports. Import from the new home instead:

```typescript
import {
  ACT_INDUSTRIES_PATH,
  buildIndustryResolver,
  loadActIndustries,
} from "../src/lib/act/industries";
```

Not `type ActIndustries` — once the local resolver is gone nothing in that file
annotates with it, and eslint flags the unused import.

```typescript
```

`DATA_PATH` appeared in one error message; use `ACT_INDUSTRIES_PATH` there:

```typescript
    console.error(`invalid names in ${ACT_INDUSTRIES_PATH}: ${invalid.join(", ")}`);
```

The one internal caller of `resolveActIndustry` is the `--merge` scan. Build
the resolver once before that loop rather than per row:

```typescript
  const resolveIndustry = buildIndustryResolver(data);

  const toMerge: { from: (typeof existing)[number]; to: string }[] = [];
  for (const row of existing) {
    const key = normalizeIndustryName(row.name);
    if (canonicalKeys.has(key)) continue;
    const target = resolveIndustry(row.name);
    if (target && normalizeIndustryName(target) !== key) {
      toMerge.push({ from: row, to: target });
    }
  }
```

`resolveActIndustry` is **not** re-exported. Nothing outside this file ever
called it — the only caller was the loop above — so a compatibility shim would
be dead code on arrival. Its module docstring currently promises the opposite
("`resolveActIndustry` below is exported for it"); correct that sentence to
point at `src/lib/act/industries.ts`, and likewise the two trailing comments
near the bottom of the file that name it.

**`scripts/seed-industry-aliases.ts`** imports `loadActIndustries` and
`type ActIndustries` from `./import-act-industries`. Repoint it:

```typescript
import { loadActIndustries, type ActIndustries } from "../src/lib/act/industries";
```

Its header comment also mentions `resolveActIndustry`; leave the sense intact
but point at the new module.

**`tests/industry-alias-seed.test.ts`** imports `loadActIndustries` from
`../scripts/import-act-industries`. Repoint it the same way:

```typescript
import { loadActIndustries } from "../src/lib/act/industries";
```

That test must keep passing unchanged otherwise — it is the existing guard on
this data file.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `tests/industry-alias-seed.test.ts` exercises this data and must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/act/industries.ts scripts/import-act-industries.ts \
  scripts/seed-industry-aliases.ts tests/industry-alias-seed.test.ts \
  tests/act-industries.test.ts
git commit -m "refactor: move the ACT! industry resolver into src and index it

Its own comment said the contact import would need it, and importing from
scripts/ into src/ is the wrong direction. The alias table is now indexed once
by normalised key instead of scanned per lookup: 352 aliases times 12,000
contacts was 4.2 million normalisations to answer 12,000 questions.

Canonical segments now resolve to themselves, which the old table did not
guarantee for every one of the 31. The data file is a static import rather than
a readFileSync, so resolving it no longer depends on the working directory.

resolveActIndustry is gone rather than re-exported: its only caller was the
--merge scan in the same file, which now builds the resolver once instead of
rescanning 352 aliases per existing row."
```

---

### Task 6: Fill-only-empty merge

**Files:**
- Create: `src/lib/act/merge.ts`
- Test: `tests/act-merge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/act-merge.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fillOnlyEmpty } from "../src/lib/act/merge";

describe("fillOnlyEmpty", () => {
  it("fills a field that is null", () => {
    expect(fillOnlyEmpty({ email: null }, { email: "a@b.c" }, ["email"])).toEqual({
      email: "a@b.c",
    });
  });

  it("fills a field that is an empty string", () => {
    expect(fillOnlyEmpty({ email: "" }, { email: "a@b.c" }, ["email"])).toEqual({
      email: "a@b.c",
    });
  });

  it("fills a field that is only whitespace", () => {
    expect(fillOnlyEmpty({ city: "   " }, { city: "Melbourne" }, ["city"])).toEqual({
      city: "Melbourne",
    });
  });

  it("never overwrites what someone typed", () => {
    // A salesperson corrected this by hand. ACT! does not get to undo it.
    expect(fillOnlyEmpty({ phone: "+61400000000" }, { phone: "+61411111111" }, ["phone"]))
      .toEqual({});
  });

  it("ignores an incoming value that is itself empty", () => {
    expect(fillOnlyEmpty({ email: null }, { email: null }, ["email"])).toEqual({});
    expect(fillOnlyEmpty({ email: null }, { email: "  " }, ["email"])).toEqual({});
  });

  it("only considers the listed fields", () => {
    expect(fillOnlyEmpty({ a: null, b: null }, { a: "x", b: "y" }, ["a"])).toEqual({ a: "x" });
  });

  it("returns an empty object when there is nothing to do", () => {
    expect(fillOnlyEmpty({ email: "a@b.c" }, { email: "a@b.c" }, ["email"])).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-merge.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/merge"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/merge.ts`:

```typescript
// The one place that decides whether a sync may change an existing value.
//
// It may not. A sync fills blanks and nothing else: what a salesperson typed
// into PathQuote is never silently replaced by what ACT! happens to hold. The
// full ACT! payload is kept in the ActSnapshot table, so a divergence can be
// shown to a person without either version being destroyed.
//
// Kept as one tiny function rather than inlined at each call site so that
// "can a sync overwrite this?" has exactly one answer, and changing it is a
// decision rather than an oversight in one branch.

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * The subset of `incoming` that may be written over `existing`: fields listed
 * in `fields` that are blank on the existing record and non-blank on the
 * incoming one.
 *
 * Returns a patch, not a merged record, so a caller can tell "nothing changed"
 * from "changed back to the same value" and skip the write entirely.
 */
export function fillOnlyEmpty<T extends Record<string, unknown>>(
  existing: Partial<T>,
  incoming: Partial<T>,
  fields: readonly (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const field of fields) {
    if (!isBlank(existing[field])) continue;
    if (isBlank(incoming[field])) continue;
    patch[field] = incoming[field];
  }
  return patch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-merge.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/merge.ts tests/act-merge.test.ts
git commit -m "feat: fill-only-empty, in one place

A sync fills blanks and never overwrites: what a salesperson typed is not
undone by whatever ACT! happens to hold. Kept as one function rather than
inlined per call site so that 'may a sync overwrite this?' has a single
answer, and changing it is a decision rather than an oversight in one branch.

It returns a patch rather than a merged record, so the caller can skip the
write when nothing actually changed."
```

---

### Task 7: Mapping one contact

**Files:**
- Create: `src/lib/act/map.ts`
- Test: `tests/act-map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/act-map.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mapContact } from "../src/lib/act/map";
import type { ActContact } from "../src/lib/act/types";

const resolveIndustry = (raw: string | null | undefined) =>
  raw === "Furniture" ? "Furniture & Upholstery" : null;

function contact(overrides: Partial<ActContact> = {}): ActContact {
  return {
    id: "72acf7a4-5af5-422d-8905-f0fe96361cb6",
    companyID: "",
    idStatus: "Prospect",
    contactType: "Contact",
    isPrivate: false,
    firstName: "Hans",
    lastName: "Helmer",
    jobTitle: "Plant Manager",
    emailAddress: "hans@efka.example",
    businessPhone: "404 457 7006",
    mobilePhone: null,
    company: "Efka America Inc.",
    website: "https://efka.example",
    businessAddress: {
      line1: "3715 Northcrest Rd.",
      line2: "Suite 10",
      line3: null,
      city: "Atlanta",
      state: "GA",
      postalCode: "30340",
      country: "United States",
    },
    recordManagerID: "015cbe53-2040-4179-8734-295732f774e5",
    recordManager: "David Cook",
    customFields: { rep: "David Cook", user6: "Furniture" },
    created: "2010-11-18T18:51:06+11:00",
    edited: "2023-08-26T03:24:14+10:00",
    ...overrides,
  };
}

describe("mapContact", () => {
  it("maps a complete contact", () => {
    const result = mapContact(contact(), resolveIndustry);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;

    expect(result.contact).toMatchObject({
      actContactId: "72acf7a4-5af5-422d-8905-f0fe96361cb6",
      firstName: "Hans",
      lastName: "Helmer",
      email: "hans@efka.example",
      phone: "+14044577006",
      position: "Plant Manager",
      actAccountMgr: "David Cook",
    });
    expect(result.contact.actEditedAt.toISOString()).toBe("2023-08-25T17:24:14.000Z");

    expect(result.company).toMatchObject({
      actCompanyKey: "efka america|US",
      actCompanyId: null,
      name: "Efka America Inc.",
      street: "3715 Northcrest Rd., Suite 10",
      city: "Atlanta",
      country: "US",
      industry: "Furniture & Upholstery",
      actStatus: "Prospect",
      actRecordManagerId: "015cbe53-2040-4179-8734-295732f774e5",
    });
  });

  it("lowercases the email", () => {
    const result = mapContact(contact({ emailAddress: "Hans@EFKA.Example" }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.email).toBe("hans@efka.example");
  });

  it("carries the ACT! company id when the contact is linked to one", () => {
    const result = mapContact(
      contact({ companyID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      resolveIndustry,
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.actCompanyId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("leaves industry null when the raw value is not in the alias table", () => {
    const result = mapContact(contact({ customFields: { user6: "Wat" } }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.industry).toBeNull();
  });

  it("skips Personal contacts even if the status filter let them through", () => {
    // These are the director's own and he shares them with nobody. The API
    // query already excludes them; this is the second barrier, on purpose.
    expect(mapContact(contact({ idStatus: "Personal" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "personal",
    });
  });

  it("skips private records", () => {
    expect(mapContact(contact({ isPrivate: true }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "private",
    });
  });

  it("skips anything that is not a Contact", () => {
    expect(mapContact(contact({ contactType: "User" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "not-a-contact",
    });
  });

  it("skips inactive statuses", () => {
    expect(mapContact(contact({ idStatus: "Dead Prospect" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "inactive-status",
    });
    expect(mapContact(contact({ idStatus: null }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "inactive-status",
    });
  });

  it("skips a contact with no name at all", () => {
    expect(
      mapContact(contact({ firstName: null, lastName: null }), resolveIndustry),
    ).toEqual({ kind: "skipped", reason: "no-name" });
  });

  it("keeps a contact whose phone could not be resolved", () => {
    // 7.8% of active contacts are in this state, almost always because the
    // country on the record is wrong. They are still real clients.
    const result = mapContact(contact({ businessPhone: "\r", mobilePhone: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.phone).toBeNull();
  });

  it("falls back to the surname when there is no first name", () => {
    const result = mapContact(contact({ firstName: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.firstName).toBe("Helmer");
    expect(result.contact.lastName).toBeNull();
  });

  it("gives a contact with no company name no company key", () => {
    const result = mapContact(contact({ company: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.actCompanyKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-map.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/map"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/map.ts`:

```typescript
import { normalizeCountryInput } from "@/lib/countries";
import { companyKey } from "@/lib/act/company-key";
import { contactPhone } from "@/lib/act/phone";
import {
  ACTIVE_STATUSES,
  ACT_FIELD,
  type ActContact,
  type MapResult,
} from "@/lib/act/types";

// One ACT! contact to the shapes PathQuote stores, or a reason it was skipped.
//
// Pure on purpose: the skip rules and the field choices are the part of this
// integration most likely to be wrong, and they are the part that can be
// tested without a database or a network.

const ACTIVE = new Set<string>(ACTIVE_STATUSES);

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function custom(contact: ActContact, key: string): string | null {
  return text(contact.customFields?.[key]);
}

/**
 * Map one contact.
 *
 * `resolveIndustry` is passed in rather than imported so this stays pure and
 * the caller builds the alias index once for the whole run.
 */
export function mapContact(
  contact: ActContact,
  resolveIndustry: (raw: string | null | undefined) => string | null,
): MapResult {
  if (text(contact.contactType) !== "Contact") {
    return { kind: "skipped", reason: "not-a-contact" };
  }
  if (contact.isPrivate === true) {
    return { kind: "skipped", reason: "private" };
  }

  const status = text(contact.idStatus);

  // Personal contacts belong to the director and he shares them with nobody.
  // This is the ONLY barrier. client.ts sends no status filter -- its sole
  // $filter is `edited ge ...` -- so every Personal contact in the CRM reaches
  // this function. That is why it is a separate, explicit check and not left
  // to fall out of the active-status test below: widening ACTIVE_STATUSES
  // later must not be able to let them through, and they get a count of their
  // own in the run report.
  if (status === "Personal") {
    return { kind: "skipped", reason: "personal" };
  }
  if (!status || !ACTIVE.has(status)) {
    return { kind: "skipped", reason: "inactive-status" };
  }

  const first = text(contact.firstName);
  const last = text(contact.lastName);
  if (!first && !last) {
    return { kind: "skipped", reason: "no-name" };
  }

  const address = contact.businessAddress;
  const rawCountry = text(address?.country ?? null);
  const country = normalizeCountryInput(rawCountry);

  // PathQuote has one street field; ACT! has three lines and uses two.
  const street =
    [text(address?.line1 ?? null), text(address?.line2 ?? null), text(address?.line3 ?? null)]
      .filter(Boolean)
      .join(", ") || null;

  const companyName = text(contact.company);
  const email = text(contact.emailAddress);

  return {
    kind: "mapped",
    contact: {
      actContactId: contact.id,
      // PathQuote requires a first name; a mononym lands there rather than
      // being dropped for having no surname.
      firstName: first ?? (last as string),
      lastName: first ? last : null,
      email: email ? email.toLowerCase() : null,
      phone: contactPhone(contact.businessPhone, contact.mobilePhone, rawCountry),
      position: text(contact.jobTitle),
      actAccountMgr: custom(contact, ACT_FIELD.accountMgr),
      actEditedAt: new Date(contact.edited),
      snapshot: contact,
    },
    company: {
      actCompanyKey: companyName ? companyKey(companyName, country) : null,
      // The API returns "" rather than null for an unlinked contact.
      actCompanyId: text(contact.companyID),
      name: companyName ?? "",
      street,
      city: text(address?.city ?? null),
      state: text(address?.state ?? null),
      postcode: text(address?.postalCode ?? null),
      country,
      website: text(contact.website),
      industry: resolveIndustry(custom(contact, ACT_FIELD.industry)),
      actStatus: status,
      actRecordManagerId: text(contact.recordManagerID),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-map.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/map.ts tests/act-map.test.ts
git commit -m "feat: map one ACT! contact to PathQuote shapes

Pure, so the skip rules can be tested without a database. They are the part of
this integration most likely to be wrong and the most expensive to get wrong.

Personal contacts are refused here, and this is the only place they are. The
API query carries no status filter, so every one of them reaches the mapper.
They are the director's own, so the check is explicit rather than a side
effect of the active-status test: if someone widens the status list later, it
still holds.

A contact whose phone would not resolve is still imported. 7.8% of active
contacts are in that state, almost always because the country on the record is
wrong, and they are real clients."
```

---

### Task 8: API client

**Files:**
- Create: `src/lib/act/client.ts`

No unit test: this file is I/O and holds no decisions. It is exercised against the real API in Task 11.

- [ ] **Step 1: Write the client**

Create `src/lib/act/client.ts`:

```typescript
import type { ActContact } from "@/lib/act/types";

// HTTP against the Act! Web API. Every judgement this integration makes lives
// in the pure modules beside this one; what is left here is transport, and it
// is deliberately dull.
//
// Three details of this API that cost time to discover, all verified against
// the live system (docs/act-integration-reference.md):
//
//   - The username is the Act! display name as shown in Manage Users --
//     "John Hollo", not "john". A wrong username and an unregistered database
//     name both return a bare 401 with no body, so they are indistinguishable
//     from the response alone.
//   - Response envelopes are not consistent. /api/contacts returns
//     { value: [...], Count: n }; /api/users and the metadata endpoints return
//     a bare array. Reading .value off a bare array yields nothing and looks
//     exactly like a permissions failure.
//   - Count is the size of the page, not a total.

export type ActClientConfig = {
  /** e.g. https://actapi.pathfindercut.com/act.web.api */
  baseUrl: string;
  database: string;
  username: string;
  password: string;
};

/** Tokens last 65 minutes; renew early rather than racing the boundary. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

const PAGE_SIZE = 200;

export class ActApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ActApiError";
  }
}

export class ActClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ActClientConfig) {}

  private async authorize(): Promise<string> {
    const credentials = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const response = await fetch(`${this.config.baseUrl}/authorize`, {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Act-Database-Name": this.config.database,
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new ActApiError(
        `authorize failed (${response.status}). Check the username is the Act! display name, the database name, and that the account has the "Web API Access" permission -- a missing permission is 4032.`,
        response.status,
        body,
      );
    }

    this.token = body.replace(/^"|"$/g, "");
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return this.token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.authorize();
  }

  /** One GET, with whatever token is current, result uninterpreted. */
  private async fetchOnce(path: string): Promise<Response> {
    const token = await this.getToken();
    return fetch(`${this.config.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Act-Database-Name": this.config.database,
      },
    });
  }

  private async parse(path: string, response: Response): Promise<unknown> {
    const body = await response.text();
    if (!response.ok) {
      throw new ActApiError(`GET ${path} failed (${response.status})`, response.status, body);
    }
    return body ? JSON.parse(body) : null;
  }

  /**
   * GET a path, re-authorising once if the token was rejected.
   *
   * Two explicit attempts rather than a loop. A `for` loop here needs a throw
   * after it to satisfy the compiler, that throw is unreachable, and its
   * message can therefore never print -- so the second 401 would surface as a
   * bare "failed (401)" while the useful sentence sat in dead code. This shape
   * has no unreachable branch and the diagnostic actually fires.
   */
  private async get(path: string): Promise<unknown> {
    const first = await this.fetchOnce(path);
    if (first.status !== 401) return this.parse(path, first);

    // Expired or revoked mid-run. Drop the cached token so the retry fetches a
    // fresh one.
    this.token = null;
    const second = await this.fetchOnce(path);
    if (second.status === 401) {
      throw new ActApiError(
        `GET ${path} failed: still 401 after re-authorising. The account may have lost its "Web API Access" permission, or the password was rotated.`,
        401,
        await second.text(),
      );
    }
    return this.parse(path, second);
  }

  /** Unwrap whichever envelope this endpoint happens to use. */
  private rows<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown }).value)) {
      return (payload as { value: T[] }).value;
    }
    return [];
  }

  /** The API version, and the Act! version behind it. Logged on every run so a
   * surprise upgrade shows up in our logs before it shows up as a bug. */
  async system(): Promise<{ apiVersion: string; sdkVersion: string }> {
    const payload = (await this.get("/api/system")) as {
      apiVersion?: string;
      sdkVersion?: string;
    };
    return {
      apiVersion: payload?.apiVersion ?? "unknown",
      sdkVersion: payload?.sdkVersion ?? "unknown",
    };
  }

  /**
   * Every contact edited since `since`, oldest first, a page at a time.
   *
   * Ordered by `edited` so a run interrupted halfway can resume from the last
   * record it stored rather than starting again. `$skip` rather than a keyset
   * cursor because the API offers no stable tiebreaker on equal timestamps;
   * at 12,000 records over ~60 pages the depth cost is irrelevant.
   */
  async *contactsEditedSince(since: Date | null): AsyncGenerator<ActContact[]> {
    let skip = 0;
    for (;;) {
      const params = new URLSearchParams({
        $top: String(PAGE_SIZE),
        $skip: String(skip),
        $orderby: "edited",
      });
      if (since) {
        // `ge`, not `gt`. The cursor is the newest `edited` this sync stored,
        // and a --limit run stops mid-stream: another record can carry that
        // same timestamp and never have been reached. `gt` would skip it
        // permanently. `ge` re-reads the boundary record instead, which
        // fill-only-empty turns into a no-op.
        params.set("$filter", `edited ge ${since.toISOString()}`);
      }

      const page = this.rows<ActContact>(await this.get(`/api/contacts?${params}`));
      if (page.length === 0) return;
      yield page;
      if (page.length < PAGE_SIZE) return;
      skip += PAGE_SIZE;
    }
  }
}

/** Build a client from the environment. Throws with the missing names rather
 * than failing later with an unhelpful 401. */
export function actClientFromEnv(): ActClient {
  const required = ["ACT_BASE", "ACT_DB", "ACT_USER", "ACT_PASS"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(", ")}`);
  }
  return new ActClient({
    baseUrl: process.env.ACT_BASE!.replace(/\/$/, ""),
    database: process.env.ACT_DB!,
    username: process.env.ACT_USER!,
    password: process.env.ACT_PASS!,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/act/client.ts
git commit -m "feat: Act! Web API client

Transport only; every decision lives in the pure modules beside it.

Handles the three things about this API that cost time to find: the username
is the Act! display name rather than a login, a wrong username and an
unregistered database both return a bare 401 with no body, and the response
envelope is inconsistent -- contacts come wrapped in value, users come as a
bare array, and reading .value off the latter looks exactly like a permissions
failure."
```

---

### Task 9: Sync worker

**Files:**
- Create: `src/lib/act/sync.ts`

No unit test: orchestration around Prisma. Its decisions are in `map.ts` and `merge.ts`, which are tested.

- [ ] **Step 1: Write the worker**

Create `src/lib/act/sync.ts`:

```typescript
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ActClient } from "@/lib/act/client";
import { buildIndustryResolver } from "@/lib/act/industries";
import { mapContact } from "@/lib/act/map";
import { fillOnlyEmpty } from "@/lib/act/merge";
import type { MappedCompany, SkipReason } from "@/lib/act/types";

// Pull contacts from ACT! into PathQuote.
//
// One operation serves both callers: the nightly job and the "Sync now"
// button. Both pass the cursor, so there is no separate full-import path to
// drift out of step with the incremental one.
//
// The cursor is the `edited` timestamp of the newest record successfully
// stored, kept in Setting. It only advances at the end of a clean run: a run
// that dies halfway leaves it alone and the next one re-reads the overlap,
// which fill-only-empty makes harmless.

const CURSOR_KEY = "act.sync.cursor";

export type SyncResult = {
  scanned: number;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  skipped: Record<SkipReason, number>;
  /** Contacts imported with no usable phone number. */
  unresolvedPhones: number;
  /** Raw industry values with no entry in the alias table, deduplicated. */
  unknownIndustries: string[];
  cursorFrom: Date | null;
  cursorTo: Date | null;
};

function emptySkips(): Record<SkipReason, number> {
  return {
    "not-a-contact": 0,
    private: 0,
    personal: 0,
    "inactive-status": 0,
    "no-name": 0,
    "no-company": 0,
  };
}

export async function readCursor(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: CURSOR_KEY } });
  const value = row?.value as { editedAt?: string } | null;
  return value?.editedAt ? new Date(value.editedAt) : null;
}

async function writeCursor(editedAt: Date): Promise<void> {
  await db.setting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: { editedAt: editedAt.toISOString() } },
    update: { value: { editedAt: editedAt.toISOString() } },
  });
}

/**
 * Store the ACT! payload behind a row.
 *
 * It lives in its own table rather than as a column so that a query wanting a
 * company name never drags a full ACT! payload with it -- see the ActSnapshot
 * model's comment. Nothing in phase 1 reads it back.
 */
async function writeSnapshot(
  owner: { contactId: string } | { companyId: string },
  payload: unknown,
): Promise<void> {
  // Prisma's Json input is InputJsonValue, not object.
  const data = payload as Prisma.InputJsonValue;
  await db.actSnapshot.upsert({
    where: owner,
    create: { ...owner, payload: data },
    update: { payload: data },
  });
}

/**
 * Find or create the PathQuote company for a mapped contact.
 *
 * A contact linked to a real ACT! Company wins on `actCompanyId`; everyone
 * else groups on the derived name+country key. Both are unique columns, so two
 * contacts of the same client converge on one row rather than racing into two.
 */
async function resolveCompany(
  company: MappedCompany,
  industryId: string | null,
  counters: { companiesCreated: number },
): Promise<string | null> {
  if (!company.name) return null;

  const existing = company.actCompanyId
    ? await db.company.findUnique({ where: { actCompanyId: company.actCompanyId } })
    : company.actCompanyKey
      ? await db.company.findUnique({ where: { actCompanyKey: company.actCompanyKey } })
      : null;

  if (!existing) {
    const created = await db.company.create({
      data: {
        name: company.name,
        street: company.street,
        city: company.city,
        state: company.state,
        postcode: company.postcode,
        country: company.country,
        website: company.website,
        industryId,
        actCompanyId: company.actCompanyId,
        actCompanyKey: company.actCompanyKey,
        actStatus: company.actStatus,
        actRecordManagerId: company.actRecordManagerId,
        actSyncedAt: new Date(),
      },
    });
    await writeSnapshot({ companyId: created.id }, company);
    counters.companiesCreated += 1;
    return created.id;
  }

  const patch = fillOnlyEmpty(
    existing,
    {
      street: company.street,
      city: company.city,
      state: company.state,
      postcode: company.postcode,
      country: company.country,
      website: company.website,
      industryId,
    },
    ["street", "city", "state", "postcode", "country", "website", "industryId"],
  );

  await db.company.update({
    where: { id: existing.id },
    data: {
      ...patch,
      actStatus: company.actStatus,
      actRecordManagerId: company.actRecordManagerId,
      actSyncedAt: new Date(),
    },
  });
  await writeSnapshot({ companyId: existing.id }, company);
  return existing.id;
}

export type SyncOptions = {
  /** Ignore the stored cursor and read everything. */
  full?: boolean;
  /** Read and map, write nothing. */
  dryRun?: boolean;
  /** Stop after this many contacts. For a first careful run. */
  limit?: number;
  onProgress?: (scanned: number) => void;
};

export async function syncContacts(
  client: ActClient,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const resolveIndustry = buildIndustryResolver();
  const since = options.full ? null : await readCursor();

  // Industry is a small fixed table, so read it once rather than asking per
  // contact -- 12,000 lookups to answer at most 31 distinct questions.
  const industryIdByName = new Map(
    (await db.industry.findMany({ select: { id: true, name: true } })).map((row) => [
      row.name,
      row.id,
    ]),
  );

  const result: SyncResult = {
    scanned: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    companiesCreated: 0,
    skipped: emptySkips(),
    unresolvedPhones: 0,
    unknownIndustries: [],
    cursorFrom: since,
    cursorTo: null,
  };
  const unknownIndustries = new Set<string>();
  let newestEdited: Date | null = null;

  for await (const page of client.contactsEditedSince(since)) {
    for (const raw of page) {
      if (options.limit && result.scanned >= options.limit) break;
      result.scanned += 1;

      const mapped = mapContact(raw, resolveIndustry);
      if (mapped.kind === "skipped") {
        result.skipped[mapped.reason] += 1;
        continue;
      }

      const rawIndustry = raw.customFields?.user6;
      if (typeof rawIndustry === "string" && rawIndustry.trim() && !mapped.company.industry) {
        unknownIndustries.add(rawIndustry.trim());
      }
      if (!mapped.contact.phone) result.unresolvedPhones += 1;

      if (!newestEdited || mapped.contact.actEditedAt > newestEdited) {
        newestEdited = mapped.contact.actEditedAt;
      }

      // PathQuote's Contact requires a company, and a contact with no company
      // name is six records out of 12,094. Decided from the mapped value rather
      // than from resolveCompany returning null, so a dry run reports the same
      // count a real run does.
      if (!mapped.company.name) {
        result.skipped["no-company"] += 1;
        continue;
      }

      if (options.dryRun) continue;

      const industryId = mapped.company.industry
        ? industryIdByName.get(mapped.company.industry) ?? null
        : null;
      const companyId = await resolveCompany(mapped.company, industryId, result);
      if (!companyId) {
        // Unreachable today: the only null resolveCompany returns is for a
        // missing name, refused above. Kept so that giving resolveCompany a
        // second reason to decline cannot silently drop a contact instead.
        result.skipped["no-company"] += 1;
        continue;
      }

      const existing = await db.contact.findUnique({
        where: { actContactId: mapped.contact.actContactId },
      });

      if (!existing) {
        const created = await db.contact.create({
          data: {
            companyId,
            firstName: mapped.contact.firstName,
            lastName: mapped.contact.lastName,
            email: mapped.contact.email,
            phone: mapped.contact.phone,
            position: mapped.contact.position,
            actContactId: mapped.contact.actContactId,
            actAccountMgr: mapped.contact.actAccountMgr,
            actSyncState: "SYNCED",
            actSourceEditedAt: mapped.contact.actEditedAt,
            actSyncedAt: new Date(),
          },
        });
        await writeSnapshot({ contactId: created.id }, mapped.contact.snapshot);
        result.contactsCreated += 1;
      } else {
        const patch = fillOnlyEmpty(
          existing,
          {
            lastName: mapped.contact.lastName,
            email: mapped.contact.email,
            phone: mapped.contact.phone,
            position: mapped.contact.position,
          },
          ["lastName", "email", "phone", "position"],
        );
        await db.contact.update({
          where: { id: existing.id },
          data: {
            ...patch,
            actAccountMgr: mapped.contact.actAccountMgr,
            actSyncState: "SYNCED",
            actSourceEditedAt: mapped.contact.actEditedAt,
            actSyncedAt: new Date(),
          },
        });
        await writeSnapshot({ contactId: existing.id }, mapped.contact.snapshot);
        result.contactsUpdated += 1;
      }

      options.onProgress?.(result.scanned);
    }
    if (options.limit && result.scanned >= options.limit) break;
  }

  result.unknownIndustries = [...unknownIndustries].sort();
  result.cursorTo = newestEdited;

  // Only after everything above succeeded. A half-finished run leaves the
  // cursor where it was and the next run re-reads the overlap, which
  // fill-only-empty makes a no-op.
  if (!options.dryRun && newestEdited) {
    await writeCursor(newestEdited);
  }

  return result;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/act/sync.ts
git commit -m "feat: the sync worker

One operation for both the nightly job and the button, so there is no separate
full-import path to drift out of step with the incremental one.

The cursor advances only after a clean run. A run that dies halfway leaves it
alone and the next one re-reads the overlap, which fill-only-empty makes a
no-op -- cheaper than tracking partial progress and impossible to get subtly
wrong.

No region is set on an imported company, because Company has no region column:
in this schema a region hangs off User, Price and Document, and a quote picks
one up from the document rather than the client. The industry table is read
once into a map instead of per contact."
```

---

### Task 10: CLI entry point

**Files:**
- Create: `scripts/act-sync.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Create `scripts/act-sync.ts`:

```typescript
/**
 * Pull contacts from ACT! into PathQuote.
 *
 *   npm run act:sync -- --dry-run --limit 50   # read and report, write nothing
 *   npm run act:sync -- --limit 200            # a careful first write
 *   npm run act:sync                           # delta since the stored cursor
 *   npm run act:sync -- --full                 # ignore the cursor, read all
 *
 * Environment (see docs/act-integration-reference.md):
 *   ACT_BASE=https://actapi.pathfindercut.com/act.web.api
 *   ACT_DB=Pathfinder
 *   ACT_USER='Marketing'
 *   ACT_PASS=...
 */
import "dotenv/config";
import { actClientFromEnv } from "../src/lib/act/client";
import { syncContacts, readCursor } from "../src/lib/act/sync";

async function main() {
  const args = new Set(process.argv.slice(2));
  const limitArg = process.argv.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : undefined;

  const client = actClientFromEnv();

  // Logged every run so an Act! upgrade is visible in our own output before it
  // is visible as a bug.
  const system = await client.system();
  console.log(`Act! Web API ${system.apiVersion}, SDK ${system.sdkVersion}`);

  const cursor = await readCursor();
  console.log(`cursor: ${cursor ? cursor.toISOString() : "none (first run)"}`);

  const result = await syncContacts(client, {
    full: args.has("--full"),
    dryRun: args.has("--dry-run"),
    limit: Number.isFinite(limit) ? limit : undefined,
    onProgress: (scanned) => {
      if (scanned % 500 === 0) console.log(`  ${scanned} scanned`);
    },
  });

  console.log("");
  console.log(`scanned            ${result.scanned}`);
  console.log(`contacts created   ${result.contactsCreated}`);
  console.log(`contacts updated   ${result.contactsUpdated}`);
  console.log(`companies created  ${result.companiesCreated}`);
  console.log(`phones unresolved  ${result.unresolvedPhones}`);
  console.log("skipped:");
  for (const [reason, count] of Object.entries(result.skipped)) {
    if (count > 0) console.log(`  ${reason.padEnd(18)} ${count}`);
  }
  if (result.unknownIndustries.length > 0) {
    console.log("");
    console.log(`industry values with no alias (${result.unknownIndustries.length}):`);
    for (const value of result.unknownIndustries) console.log(`  ${value}`);
    console.log("Add the real ones to scripts/data/act-industries.json. Never let the");
    console.log("importer create industries: free text is what produced 335 spellings.");
  }
  console.log("");
  console.log(`cursor now: ${result.cursorTo ? result.cursorTo.toISOString() : "unchanged"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in `"scripts"`, after `"import:act-industries"`:

```json
    "act:sync": "tsx scripts/act-sync.ts",
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/act-sync.ts package.json
git commit -m "feat: act:sync CLI

Dry-run and limit exist so the first contact with production data is a small
one that writes nothing. The run prints unresolved industry values rather than
creating them -- auto-creating is what produced 335 spellings of 31 trades."
```

---

> **Note, added after implementation.** Tasks 1-10 are done. Review then found
> four defects that changed the design, so the code blocks above are no longer a
> faithful transcript of what shipped — read `src/lib/act/` for that. What
> changed, and why, is in the commits on this branch: the ACT! payload moved to
> an `ActSnapshot` side table, the company-identity decision became a pure
> tested module (`company-identity.ts`) after the original version crashed every
> run on a unique-key collision, the cursor is checkpointed per page and never
> by a limited run, and the CLI refuses unknown flags. Task 11 below has been
> amended to match.

### Task 11: First run against the real database

**Files:** none — this is verification.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS, including the five new files.

- [ ] **Step 2: Dry run, small**

```bash
export ACT_BASE=https://actapi.pathfindercut.com/act.web.api
export ACT_DB=Pathfinder
export ACT_USER='Marketing'
read -rs -p "ACT password: " ACT_PASS; export ACT_PASS; echo

npm run act:sync -- --dry-run --limit 50
```

Expected: the API version line, 50 scanned, a skip breakdown, and no database writes. If authorize fails, the account needs `Web API Access` — see `docs/act-integration-reference.md`.

- [ ] **Step 3: Dry run, everything**

Run: `npm run act:sync -- --dry-run --full`

Expected, from the measured export: roughly 12,100 mapped, around 5,300 skipped (`inactive-status` the bulk of it), and `phones unresolved` near 11% of those mapped.

Nothing is filtered server-side: the only `$filter` is `edited ge ...`, and on a `--full` run not even that. So `scanned` should be close to the total contact count (17,373 when last measured), not to the 12,100 that will be mapped, and every Personal contact in the CRM is read before the mapper skips it. A non-zero `personal` count is therefore **expected**, not a warning. What matters is that those contacts were skipped and none were written; if you want to confirm the number, compare it with the count of `Personal` in the ACT! ID/Status picklist.

Numbers far from these mean the filters are wrong. Stop and compare against the spec rather than writing.

- [ ] **Step 4: First write, small**

Run: `npm run act:sync -- --limit 200`

Then check what landed:

```sql
SELECT COUNT(*) FROM "Contact" WHERE "actContactId" IS NOT NULL;
SELECT COUNT(*) FROM "Company" WHERE "actCompanyKey" IS NOT NULL;
SELECT "name", "city", "country" FROM "Company" WHERE "actCompanyKey" IS NOT NULL LIMIT 10;
SELECT "firstName", "lastName", "phone", "actAccountMgr" FROM "Contact" WHERE "actContactId" IS NOT NULL LIMIT 10;
```

Phones should be E.164 or null, never a raw ACT! spelling. Countries should be ISO-2.

- [ ] **Step 5: Run it twice and confirm the second is a no-op**

```bash
npm run act:sync
npm run act:sync
```

Expected: the second run scans few or no records (the cursor moved) and creates nothing. If it re-creates companies, the uniqueness of `actCompanyKey` is not doing its job — that is a bug worth stopping for, because it means one client can end up with two company records and quotes split between them.

- [ ] **Step 6: Full import**

Run: `npm run act:sync -- --full`

- [ ] **Step 7: Commit the observed numbers into the reference document**

Add a short section to `docs/act-integration-reference.md` under section 10 recording what the first full import produced: contacts, companies, unresolved phones, unknown industry values. The next person to run this needs a baseline to compare against, and today's numbers are the only honest one.

```bash
git add docs/act-integration-reference.md
git commit -m "docs: what the first full ACT! import actually produced

A baseline, so the next person running this can tell a bad run from a normal
one. Without it, 'is 11% unresolved phones a problem?' has no answer."
```

---

## Not in this phase

Writes back to ACT!, the n8n lead pipeline, the "Sync now" button in the UI, contact search, and the per-user visibility filter. The last of those is deliberately deferred — PathQuote has one user and that user is an admin — but this phase imports `Contact.actAccountMgr` and the company country from day one, so switching it on later is a filter and a migration rather than a re-import.
