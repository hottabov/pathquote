# Write-back: every quote's contact sits on a real ACT! company, and its records are owned by its author — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a quote's row reaches ACT!, its contact ends up associated with a real ACT! Company that carries PathQuote's business and shipping address, the deal's opportunity and History hang on that company, and the contact, the company and the opportunity PathQuote creates are owned by the quote's author (by name), not by the login.

**Architecture:** Six new planner steps slot into the existing ActOutbox sequence (`nextStep` in `src/lib/act/outbox-plan.ts`): `set-owner` (contact, company, opportunity), `resolve-company`, `create-company`, `write-company`, `link-contact-company`, `associate-opportunity-company`. Every decision is a pure function — the company lookup and its verdicts (`src/lib/act/company-resolve.ts`), the owner rule (`src/lib/act/record-owner.ts`), the company bodies (`src/lib/act/write-payloads.ts`), the planner, the admin decisions (`src/lib/act/outbox-admin.ts`) — and the drain (`src/lib/act/drain.ts`) and the client (`src/lib/act/client.ts`) stay thin I/O shells. Each step's result is stored on the record it concerns (Company, Contact, Document) or on the row (`ActOutbox.companyWrittenAt`), so a row resumes and no create repeats blind. An ambiguous company holds every quote on it for an administrator (`blockedBy "company"`), who picks one of the stored candidates on the quote's ACT! card or chooses "Create a new company in ACT!".

**Tech Stack:** Next.js server actions, Prisma 7 / PostgreSQL, ACT! Web API v1.1, vitest (`isolate: false`: no mocks, no network, no database in tests).

**Context — read before starting:** `docs/superpowers/specs/2026-10-15-act-write-back-companies.md` is the source of truth (decisions C1–C5 and O1, §3 what ACT! does as probed live, §4 the flow). `docs/superpowers/specs/2026-10-10-act-write-back.md` and `docs/superpowers/plans/2026-10-12-act-write-back-quotes.md` are the feature this extends. The header of `src/lib/act/outbox-plan.ts` is the contract every step obeys; read it whole.

---

## What this plan does NOT do

- Write any company field but the two addresses: never `name`, website, phone, industry, notes (spec §5, old spec §6/6b).
- Read every ACT! company into PathQuote. Only the per-name lookup is added.
- Relink a contact ACT! already associates with a company (C5).
- Re-own anything created before this ships (Danam's contact, Q-US-2026-001's), or anything PathQuote found rather than made, or any History (ACT! will not re-own a History).
- Backfill companies for quotes nobody touches. A finished quote gets its company at its next event (finalise, signature, acceptance); an unfinished one at the next pass.
- Count company holds separately on the Settings page (`readOutboxStanding` in `src/lib/queries/act-sync.ts` counts them under "held", which is correct; a separate count is a follow-up).

---

## Facts this plan relies on, with sources

From spec §3 (probed live on production, 2026-10-16, `scripts/act-company-probe.ts`). **Do not re-derive these.**

| Fact | Request shape (copied from the probe) |
|---|---|
| Company lookup by name: `startswith` works, case-insensitive | `GET /api/companies?$filter=startswith(name,'<prefix>')&$top=…` |
| Contact ↔ company is an association, `companyID` stays `""` | `GET /api/contacts/{id}/associated-companies` (no query), `PUT /api/contacts/{contactId}/associated-companies/{companyId}` (no body), read back |
| Company create | `POST /api/companies` with `{ name, address, shippingAddress }` → 201 with the record; addresses carry `latitude`/`longitude` back |
| Opportunity ↔ company association | `PUT /api/opportunities/{id}/associated-companies/{companyId}`, `GET /api/opportunities/{id}/associated-companies` |
| Owner | `recordManagerID` is ignored on create and PATCH; a **partial** `PATCH {id, recordManager: <name>}` is taken on contact, company and opportunity (Inactive users too); History cannot be re-owned |
| Owner's name | `GET /api/users`, the user whose `id` is `User.actUserId`: `username`, else `displayName` (the order `ownerAll` in the probe used, and ACT! took) |
| Country on a company address | a Countries picklist item: `actCountryValue` in `src/lib/act/country-picklist.ts` |
| ACT! holds **126** Company records | `docs/act-integration-reference.md` §5 — a name lookup never comes near `LOOKUP_TOP` |

**The migration is `z71_act_write_back_companies`**: `z68_quote_document_choice` and `z69_l_series_install_by_model` are committed, and `z70_perf_indexes` (the 2026-10-16 performance audit's two list-page indexes) was in the working tree, uncommitted, when this plan was written. Run `ls prisma/migrations` before Task 6 and take the next free number; if it is not z71, replace `z71_act_write_back_companies` everywhere in this plan (the migration's directory, its comment, `tests/act-outbox-sql.test.ts`, `src/lib/act/outbox-sql.ts`, the planner header).

**`npx tsc -p tests --noEmit` has 14 pre-existing errors in unrelated files.** Every task ends with that count still at 14: run `npx tsc -p tests --noEmit 2>&1 | grep -c "error TS"`.

---

## Decisions this plan makes where the spec left room

1. **Owner is a planner step of its own (`set-owner`), driven by a pending fact stored with the record's id.** The create stores, in the same write as the new id, the ACT! user the record is to be owned by (`Contact.actOwnerPendingUserId`, `Company.actOwnerPendingUserId`, `Document.actOpportunityOwnerPendingUserId` — the row's author's `User.actUserId`, nothing when the author has none). `set-owner` reads the record, PATCHes `recordManager` only when it does not already read so, and clears the fact. Why not the tail of the create step: the header's STEPS RESUME rule stores a create's id the moment ACT! answers; an owner PATCH after that store that failed would be lost (the planner sees the create done), and the planner must never plan a create again to retry it. This still meets the spec's "a resumed step re-checks and re-sends only when the owner is still wrong": the decision is made on a fresh read every time. **Failure of the owner PATCH is classified like every PATCH**: no answer, a 5xx, a 429/408 → backoff and retry; a refusal or a denial → held `blockedBy "act"` with "Try again now". Two non-failures clear the fact without holding anything: the pending user is no longer among ACT!'s users (logged; the login keeps it), and ACT! answers but the record reads back unchanged (logged; the History behaviour, should it ever appear on another record).
2. **The owner PATCH is partial** (`{ ...patch, id }`, new `ActClient.setRecordManager`), not the client's usual whole-record read-modify-write: the partial body is exactly what the probe proved on all three record types, while a whole record would carry the login's `recordManagerID` beside the new name — a combination nobody has tried.
3. **The "create new" choice is a column, `Company.actCreateChosenAt`, not a sentinel in `actCompanyId`.** `actCompanyId` is `@unique` (two companies with a sentinel would collide) and is read everywhere as an ACT! uuid (`companiesOf` in `write-payloads.ts` would send the sentinel to ACT!). The same column records resolve-company's own "ACT! has none of that name". The candidates an administrator saw are **kept** (`Company.actCompanyCandidates`) when they choose to create: create-company looks the name up before every POST and creates only when nothing it has not already seen is there.
4. **A company create in flight does not block on its own** (unlike the contact's): a company has an identity ACT! can be asked about — its name, C1 — so `create-company` looks it up before every POST. A company of the name it has not seen is adopted when exactly one (in-country) is there — owned too, when the marker stands, since that is the one the lost POST made — and held for an administrator otherwise. No POST ever goes out while an unseen company of that name exists. The hold for every quote on the company is `Company.actCompanyHeldAt`, which the planner blocks on.
5. **`write-company` is once per row** (`ActOutbox.companyWrittenAt`, cleared by a take-over): C3 makes PathQuote the master for both addresses, written on every finalise, signature and acceptance. Address fields PathQuote has blank clear ACT!'s (master); **an address PathQuote has nothing at all for is left as ACT! has it**; ACT!'s three lines are kept when PathQuote's street is exactly those lines joined with ", " (how `mapContact` in `src/lib/act/map.ts` built it); country is written only when it resolves to a picklist item. Nested objects are written whole, built from the record as read (`record-write.ts`'s rule), so `latitude`/`longitude` and anything else ACT! keeps survive.
6. **`link-contact-company` and `associate-opportunity-company` are once per contact / per deal** (`Contact.actCompanyLinkedFor`, `Document.actOpportunityCompanyId`, each the ACT! company id settled for), so a later company change re-plans them and an opportunity made before this change is associated at its next event.
7. **A journaled revision is `done` only once its records are settled** (owner pending, company, its addresses for this row, link, opportunity's company) — but only while the contact is in ACT!, so a journaled row with no contact is still `done`, as today.
8. **An ACT! company already carried by another PathQuote company** (`Company.actCompanyId` is unique) is held for an administrator with that one candidate marked `takenBy`; "Use this company" refuses it and names the other client (a merge is the developer's).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/act/record-write.ts` | modify — `PUT` joins the methods (associations), classified and retried like `PATCH` |
| `src/lib/act/record-owner.ts` | create — the owner's name off `GET /api/users`, and whether a record needs its owner set |
| `src/lib/act/company-resolve.ts` | create — the name lookup's filter, matching, narrowing by country, every resolve/create/link verdict, the stored candidates, the hold's sentence |
| `src/lib/act/write-payloads.ts` | modify — `newCompanyBody`, `companyAddressPatch`, `streetLines` |
| `src/lib/act/types.ts` | modify — `ActCompany` |
| `src/lib/act/client.ts` | modify — companies, associations, `setRecordManager` |
| `prisma/schema.prisma`, `prisma/migrations/z71_act_write_back_companies/migration.sql` | modify/create — ten nullable columns |
| `src/lib/act/outbox-sql.ts` | modify — a take-over clears `companyWrittenAt` |
| `src/lib/act/outbox-plan.ts` | modify — the six steps, the header contract |
| `src/lib/act/drain-rules.ts` | modify — `BLOCKED_BY.company`, `stepAction` for the new kinds |
| `src/lib/act/drain.ts` | modify — the owner step (Task 7), the company steps (Task 10) |
| `src/lib/act/outbox-admin.ts`, `outbox-admin-store.ts`, `src/lib/actions/act-outbox.ts` | modify — "Use this company", "Create a new company in ACT!" |
| `src/lib/act/quote-act-view.ts`, `src/lib/queries/act-quote.ts`, `src/components/documents/act-state-card.tsx`, `src/components/documents/act-admin-actions.tsx` | modify — the card lists candidates for an administrator |
| `src/lib/act/write-preflight.ts`, `scripts/act-write-preflight.ts` | modify — checks 11 (company filter) and 12 (owners) |
| `scripts/act-show-quote.ts` | modify — the ACT! company, its owner, the associations |
| `docs/runbook.md`, `docs/act-integration-reference.md` | modify — §4d, §3/§5/§9 |

Tasks 1–4 are pure and tested; 5 and 6 are I/O and schema; 7 turns owners on; 8–9 give an administrator the company actions; 10 turns companies on — last, so nothing is ever held without a way out; 11–13 are checks and docs.

---

### Task 1: `PUT`, for associations

**Files:** modify `src/lib/act/record-write.ts`, `tests/act-record-write.test.ts`

An association is a `PUT` with no body between two records that both exist; sending it twice leaves one association. So it is classified and repeated exactly as a `PATCH` is.

- [ ] **Step 1: Write the failing test** — append to `tests/act-record-write.test.ts`:

```typescript
describe("PUT, which only associates two records that both exist", () => {
  it("is repeated after a lost answer, like a PATCH: associating twice leaves one association", () => {
    expect(isRetried("PUT")).toBe(true);
  });

  it("is classified exactly as a PATCH is, for every kind of answer", () => {
    const answers = [200, 204, 301, 400, 404, 408, 409, 429, 500, 503, "not-sent", "no-answer", "unreadable"] as const;
    for (const answer of answers) {
      expect(classifyWriteFailure("PUT", answer)).toBe(classifyWriteFailure("PATCH", answer));
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-record-write.test.ts && npx tsc -p tests --noEmit 2>&1 | grep act-record-write`
Expected: vitest passes (the runtime already treats any non-POST method this way), and tsc FAILS with `Argument of type '"PUT"' is not assignable to parameter of type 'HttpMethod'` — the type is the gap.

- [ ] **Step 3: Implement** — in `src/lib/act/record-write.ts` replace

```typescript
/** The methods the client sends. No PUT: nothing here needs one. */
export type HttpMethod = "GET" | "POST" | "PATCH";
```

with

```typescript
/**
 * The methods the client sends. PUT only associates two records that both
 * exist -- a contact or an opportunity with a company, `PUT
 * /api/{contacts|opportunities}/{id}/associated-companies/{companyId}`, no
 * body (verified live, 2026-10-16: docs/superpowers/specs/2026-10-15-act-write-back-companies.md
 * section 3) -- and makes nothing new, so it is classified and repeated as a
 * PATCH is.
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT";
```

and in `isRetried`'s comment, after the sentence ending "writes the same values the first did.", add:

```typescript
 * PUT associates two records that both exist; a second copy associates them
 * again, which leaves the one association the first made.
```

In the table above `classifyWriteFailure`, change the row label `GET, PATCH` to `GET, PATCH, PUT`. No code changes: `isRetried` is `method !== "POST"`, and `classifyWriteFailure` treats every method but POST alike.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-record-write.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npx eslint src/lib/act/record-write.ts tests/act-record-write.test.ts`
Expected: PASS; no app errors; `14`; eslint clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/record-write.ts tests/act-record-write.test.ts
git commit -m "act: PUT joins the client's methods, for associating a record with a company

ACT! links a contact or an opportunity to a company with a PUT on its
associated-companies, no body (probed live 2026-10-16). It makes nothing
new, so a second copy leaves the one association the first made: PUT is
repeated and classified exactly as a PATCH is."
```

---

### Task 2: Who owns what PathQuote creates

**Files:** create `src/lib/act/record-owner.ts`, `tests/act-record-owner.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/act-record-owner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { OWNER_COLLECTION, actUserName, ownerPatch, ownerTaken } from "../src/lib/act/record-owner";

const ENRICO = "a1000000-0000-4000-8000-000000000001";
const JOHN = "a1000000-0000-4000-8000-000000000002";
const USERS = [
  { id: ENRICO, username: "Enrico Zamarra", displayName: "Enrico Zamarra", status: "Inactive" },
  { id: JOHN, username: "  John Hollo ", displayName: "John Hollo", status: "Active" },
  { id: "a1000000-0000-4000-8000-000000000003", username: "", displayName: "Marketing" },
  { id: "a1000000-0000-4000-8000-000000000004", username: null, displayName: "  " },
];

describe("actUserName", () => {
  it("is the ACT! user's username, which is the display name ACT! takes, trimmed", () => {
    expect(actUserName(USERS, ENRICO)).toBe("Enrico Zamarra");
    expect(actUserName(USERS, JOHN)).toBe("John Hollo");
  });

  it("finds the user whatever the case of its id", () => {
    expect(actUserName(USERS, ENRICO.toUpperCase())).toBe("Enrico Zamarra");
  });

  it("falls back to displayName when there is no username", () => {
    expect(actUserName(USERS, "a1000000-0000-4000-8000-000000000003")).toBe("Marketing");
  });

  it("is null for a user ACT! does not list, or one with no name at all", () => {
    expect(actUserName(USERS, "a1000000-0000-4000-8000-0000000000ff")).toBeNull();
    expect(actUserName(USERS, "a1000000-0000-4000-8000-000000000004")).toBeNull();
  });
});

describe("ownerPatch", () => {
  it("sends the name when the record is owned by somebody else, or by nobody it says", () => {
    expect(ownerPatch("John Hollo", "Enrico Zamarra")).toEqual({ recordManager: "Enrico Zamarra" });
    expect(ownerPatch(null, "Enrico Zamarra")).toEqual({ recordManager: "Enrico Zamarra" });
    expect(ownerPatch(undefined, "Enrico Zamarra")).toEqual({ recordManager: "Enrico Zamarra" });
  });

  it("sends nothing when the record already reads so, spacing and case aside", () => {
    expect(ownerPatch(" enrico zamarra", "Enrico Zamarra")).toBeNull();
  });
});

describe("ownerTaken", () => {
  it("says whether the record read back after the PATCH carries the name", () => {
    expect(ownerTaken("Enrico Zamarra", "Enrico Zamarra")).toBe(true);
    expect(ownerTaken("John Hollo", "Enrico Zamarra")).toBe(false);
    expect(ownerTaken(42, "Enrico Zamarra")).toBe(false);
  });
});

describe("OWNER_COLLECTION", () => {
  it("names the three record types ACT! lets PathQuote re-own, and no History", () => {
    expect(OWNER_COLLECTION).toEqual({ contact: "contacts", company: "companies", opportunity: "opportunities" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-record-owner.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/act/record-owner'`

- [ ] **Step 3: Implement** — `src/lib/act/record-owner.ts`:

```typescript
// Who owns what PathQuote creates in ACT!: the quote author's ACT! user, set
// BY NAME after the create -- decision O1 in
// docs/superpowers/specs/2026-10-15-act-write-back-companies.md.
//
// WHY BY NAME, AND AFTER. ACT! ignores recordManagerID on a create and on a
// PATCH, for opportunities, contacts, companies and History alike: every
// record PathQuote made came back owned by the login
// (`npm run act:company-probe -- --owner`, 2026-10-16). A PATCH of
// `recordManager` -- the user's name -- IS taken on an opportunity, a contact
// and a company, an Inactive user's included (Enrico Zamarra), and
// recordManagerID follows (`--owner-all`, the same day). A History cannot be
// re-owned at all: ACT! answers the PATCH 200 and keeps the login. So the
// owner is a step of its own after each of those three creates (OWNER BY NAME
// in src/lib/act/outbox-plan.ts), and nothing here is asked about a History.
//
// WHICH NAME. The one GET /api/users gives for User.actUserId: `username`,
// which on this server is the display name of Manage Users ("John Hollo";
// the header of src/lib/act/client.ts), else `displayName`. That order is the
// probe's (ownerAll in scripts/act-company-probe.ts), and is what ACT! took.
//
// An author with no ACT! user -- a distributor never linked in Settings ->
// Users -- has nothing to set: the login owns what is written for them. The
// drain then stores no pending owner at all.
//
// Pure, for the suite (vitest.config.ts).

import { sameRecordId } from "@/lib/act/record-write";

/** The three records PathQuote creates that ACT! lets it re-own. Never a History. */
export type OwnerRecord = "contact" | "company" | "opportunity";

/** Where each lives in the API: `/api/{collection}/{id}`. */
export const OWNER_COLLECTION = {
  contact: "contacts",
  company: "companies",
  opportunity: "opportunities",
} as const satisfies Record<OwnerRecord, string>;

function named(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The name to own a record by: the ACT! user whose id is `actUserId`, by its
 * `username`, else its `displayName`, trimmed. Null when ACT! lists no such
 * user, or one with no name -- the drain then leaves the record to the login
 * and says so in its log.
 */
export function actUserName(
  users: readonly { id?: unknown; username?: unknown; displayName?: unknown }[],
  actUserId: string,
): string | null {
  const user = users.find((u) => typeof u.id === "string" && sameRecordId(u.id, actUserId));
  if (!user) return null;
  return named(user.username) ?? named(user.displayName);
}

function sameName(value: unknown, name: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === name.trim().toLowerCase();
}

/** The body of the owner PATCH, beside `id`: ActClient.setRecordManager sends `{ ...patch, id }`. */
export type OwnerPatch = { recordManager: string };

/**
 * What set-owner sends, decided on the record as read: nothing when it
 * already reads `name` (a resumed step whose PATCH went through before its
 * result was stored), else the name. Compared trimmed and without regard to
 * case: ACT! user names are not told apart by either.
 */
export function ownerPatch(currentRecordManager: unknown, name: string): OwnerPatch | null {
  return sameName(currentRecordManager, name) ? null : { recordManager: name };
}

/**
 * Whether the record read back after set-owner carries `name`. False is ACT!
 * answering and keeping the owner, as it does for a History: the drain logs
 * it and clears the pending owner all the same, since sending the same PATCH
 * again would be answered the same way.
 */
export function ownerTaken(readBackRecordManager: unknown, name: string): boolean {
  return sameName(readBackRecordManager, name);
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-record-owner.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npx eslint src/lib/act/record-owner.ts tests/act-record-owner.test.ts`
Expected: PASS (8 tests); `14`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/record-owner.ts tests/act-record-owner.test.ts
git commit -m "act: a record PathQuote creates is owned by its author, by name

ACT! ignores recordManagerID on a create and on a PATCH, so everything the
write-back made came back owned by the login. A PATCH of recordManager --
the user's name -- is taken on a contact, a company and an opportunity,
Inactive users included, and never on a History (probed 2026-10-16).

This is the rule: the name is the ACT! user's username, else its
displayName, as the probe sent it; nothing is sent to a record that
already reads so."
```

---

### Task 3: Finding the quote's company in ACT!

**Files:** create `src/lib/act/company-resolve.ts`, `tests/act-company-resolve.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/act-company-resolve.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  associationIncludes,
  beforeCompanyCreate,
  candidateLine,
  candidateOf,
  companyHeldReason,
  companyNameFilter,
  companyNamePrefix,
  contactLink,
  fromAssociations,
  fromNameLookup,
  readCandidates,
  sameNamed,
  type CompanyCandidate,
} from "../src/lib/act/company-resolve";

const A = "c0000000-0000-4000-8000-0000000000e1";
const B = "c0000000-0000-4000-8000-0000000000e2";
const C = "c0000000-0000-4000-8000-0000000000e3";

function row(id: string | null, name: string, country: string | null = null, city: string | null = null) {
  return { ...(id ? { id } : {}), name, address: { city, country, latitude: null, longitude: null } };
}

describe("companyNamePrefix", () => {
  it("asks ACT! for the name's first word", () => {
    expect(companyNamePrefix("Flynt Amtex Inc")).toBe("Flynt");
  });

  it("asks for the first two when the first is shorter than 4 characters", () => {
    expect(companyNamePrefix("The Plastics Co")).toBe("The Plastics");
    expect(companyNamePrefix("3M Australia")).toBe("3M Australia");
  });

  it("asks for a short name that is all there is", () => {
    expect(companyNamePrefix("ABC")).toBe("ABC");
  });

  it("leaves out punctuation at a word's ends, which ACT!'s spelling of the name may not share", () => {
    expect(companyNamePrefix("Danam (Fiji) Pte Limited")).toBe("Danam");
    expect(companyNamePrefix('"Acme" Holdings')).toBe("Acme");
  });

  it("is null for a name with nothing in it to look up", () => {
    expect(companyNamePrefix("   ")).toBeNull();
    expect(companyNamePrefix("— ...")).toBeNull();
  });
});

describe("companyNameFilter", () => {
  it("is startswith on the name, the prefix as an OData literal", () => {
    expect(companyNameFilter("Flynt")).toBe("startswith(name,'Flynt')");
    expect(companyNameFilter("O'Brien")).toBe("startswith(name,'O''Brien')");
  });
});

describe("sameNamed", () => {
  it("keeps the rows whose name folds to the PathQuote name's: case, punctuation and legal form aside", () => {
    const rows = [row(A, "Flynt Amtex Inc."), row(B, "FLYNT AMTEX"), row(C, "Flynt Amtex Logistics")];
    expect(sameNamed(rows, "Flynt Amtex Inc").map((r) => r.id)).toEqual([A, B]);
  });

  it("drops a row with no id: nothing could be stored for it", () => {
    expect(sameNamed([row(null, "Flynt Amtex Inc.")], "Flynt Amtex Inc")).toEqual([]);
  });

  it("matches nothing for a name that folds to nothing", () => {
    expect(sameNamed([row(A, "...")], "!!!")).toEqual([]);
  });
});

describe("fromAssociations: the contact's own companies come first", () => {
  it("finds nothing when the contact is associated with no company", () => {
    expect(fromAssociations([], "FJ")).toEqual({ kind: "none" });
  });

  it("uses the one company the contact is associated with, whatever its country", () => {
    expect(fromAssociations([row(A, "Danam Fiji", "Australia")], "FJ")).toEqual({ kind: "use", id: A });
  });

  it("narrows several by the PathQuote company's country, ACT!'s country read as countries.ts reads it", () => {
    const rows = [row(A, "Danam", "Fiji", "Suva"), row(B, "Danam", "Australia", "Sydney")];
    expect(fromAssociations(rows, "FJ")).toEqual({ kind: "use", id: A });
  });

  it("holds when several are left in the country, or none, naming them all", () => {
    const rows = [row(A, "Danam", "Fiji", "Suva"), row(B, "Danam", "Fiji", "Lautoka"), row(C, "Danam", "Australia")];
    const held = fromAssociations(rows, "FJ");
    expect(held.kind).toBe("hold");
    if (held.kind === "hold") expect(held.candidates.map((c) => c.id)).toEqual([A, B, C]);
    expect(fromAssociations([row(A, "Danam", "Fiji"), row(B, "Danam", "Fiji")], "NZ").kind).toBe("hold");
  });

  it("holds several when the PathQuote company has no country to narrow by", () => {
    expect(fromAssociations([row(A, "Danam", "Fiji"), row(B, "Danam", "Australia")], null).kind).toBe("hold");
  });
});

describe("fromNameLookup", () => {
  it("creates when ACT! has nothing of that name: rows of other names do not count", () => {
    expect(fromNameLookup([], "Danam (Fiji) Pte Limited", "FJ")).toEqual({ kind: "create" });
    expect(fromNameLookup([row(A, "Danam Logistics")], "Danam (Fiji) Pte Limited", "FJ")).toEqual({ kind: "create" });
  });

  it("uses the one company of that name, even in another country (C1)", () => {
    expect(fromNameLookup([row(A, "Danam (Fiji) Pte Ltd", "Australia")], "Danam (Fiji) Pte Limited", "FJ")).toEqual({
      kind: "use",
      id: A,
    });
  });

  it("narrows several of that name by country, and holds when that leaves several or none (C4)", () => {
    // "Pte" is not among company-key.ts's legal forms, so it is part of the
    // identity: these three all fold to "danam fiji".
    const rows = [row(A, "Danam Fiji Ltd", "Fiji"), row(B, "DANAM FIJI", "Australia")];
    expect(fromNameLookup(rows, "Danam Fiji Limited", "FJ")).toEqual({ kind: "use", id: A });
    expect(fromNameLookup(rows, "Danam Fiji Limited", "US").kind).toBe("hold");
  });
});

describe("beforeCompanyCreate: the lookup before every company POST", () => {
  const name = "Danam Fiji Ltd";

  it("posts when ACT! has nothing of that name", () => {
    expect(beforeCompanyCreate({ rows: [], name, country: "FJ", seen: [], inFlight: false })).toEqual({ kind: "post" });
  });

  it("posts when every company of that name is one an administrator saw and chose to create beside", () => {
    const rows = [row(A, "Danam Fiji", "Fiji"), row(B, "Danam Fiji", "Fiji")];
    expect(beforeCompanyCreate({ rows, name, country: "FJ", seen: [A, B.toUpperCase()], inFlight: false })).toEqual({ kind: "post" });
  });

  it("adopts the one company of that name nobody has seen, as PathQuote's own when a create's answer was lost", () => {
    expect(beforeCompanyCreate({ rows: [row(C, "Danam Fiji")], name, country: "FJ", seen: [], inFlight: true })).toEqual({
      kind: "use",
      id: C,
      ours: true,
    });
    expect(beforeCompanyCreate({ rows: [row(C, "Danam Fiji")], name, country: "FJ", seen: [], inFlight: false })).toEqual({
      kind: "use",
      id: C,
      ours: false,
    });
  });

  it("adopts the unseen one in the company's country beside companies already seen", () => {
    const rows = [row(A, "Danam Fiji", "Fiji"), row(B, "Danam Fiji", "Fiji"), row(C, "Danam Fiji", "Fiji")];
    expect(beforeCompanyCreate({ rows, name, country: "FJ", seen: [A, B], inFlight: true })).toEqual({ kind: "use", id: C, ours: true });
  });

  it("holds, naming every company of that name, when the unseen ones cannot be told apart", () => {
    const rows = [row(A, "Danam Fiji", "Fiji"), row(B, "Danam Fiji", "Fiji"), row(C, "Danam Fiji", "Fiji")];
    const verdict = beforeCompanyCreate({ rows, name, country: "FJ", seen: [A], inFlight: true });
    expect(verdict.kind).toBe("hold");
    if (verdict.kind === "hold") expect(verdict.candidates.map((c) => c.id)).toEqual([A, B, C]);
  });
});

describe("candidateOf and readCandidates: what is stored for the hold", () => {
  it("keeps the id, the name and where the company is, as ACT! has them", () => {
    expect(candidateOf({ id: A, name: "Danam", address: { city: " Suva ", country: "Fiji" } })).toEqual({
      id: A,
      name: "Danam",
      city: "Suva",
      country: "Fiji",
      takenBy: null,
    });
    expect(candidateOf({ id: A, name: null, address: null }, "Danam (Fiji) Pte Limited")).toEqual({
      id: A,
      name: "(no name in ACT!)",
      city: null,
      country: null,
      takenBy: "Danam (Fiji) Pte Limited",
    });
  });

  it("reads back what was stored, and drops anything that is not a candidate", () => {
    const stored: CompanyCandidate[] = [{ id: A, name: "Danam", city: "Suva", country: "Fiji", takenBy: null }];
    expect(readCandidates(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readCandidates([{ id: A }, { name: "x" }, null, 3, ...stored])).toEqual(stored);
    expect(readCandidates(null)).toEqual([]);
    expect(readCandidates({ id: A })).toEqual([]);
  });
});

describe("companyHeldReason: the sentence a manager reads", () => {
  const fiji: CompanyCandidate = { id: A, name: "Danam Fiji", city: "Suva", country: "Fiji", takenBy: null };
  const lautoka: CompanyCandidate = { ...fiji, id: B, city: "Lautoka" };

  it("names the candidates and says an administrator chooses", () => {
    expect(companyHeldReason("Danam (Fiji) Pte Limited", [fiji, lautoka])).toBe(
      'ACT! has 2 companies that could be "Danam (Fiji) Pte Limited" (Danam Fiji, Suva, Fiji; Danam Fiji, Lautoka, Fiji), and PathQuote will not guess which — an administrator chooses one, or has a new one created, on this quote\'s page.',
    );
  });

  it("lists five and counts the rest", () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ ...fiji, id: `${A}-${n}`, city: `City ${n}` }));
    expect(companyHeldReason("Danam", many)).toContain("Danam Fiji, City 5, Fiji; and 2 more)");
  });

  it("says when the company found is already another PathQuote client's", () => {
    expect(companyHeldReason("Danam (Fiji) Pte Limited", [{ ...fiji, takenBy: "Danam Fiji" }])).toBe(
      'ACT!\'s company "Danam Fiji" is already PathQuote\'s client "Danam Fiji", so PathQuote cannot link it to "Danam (Fiji) Pte Limited" as well — an administrator settles it on this quote\'s page, or your developer merges the two clients.',
    );
  });

  it("says when there was nothing to look the name up by", () => {
    expect(companyHeldReason("—", [])).toBe(
      'PathQuote cannot look "—" up in ACT! by its name, so it will not create it there blind — an administrator settles it on this quote\'s page.',
    );
  });

  it("prints a candidate with no address as such", () => {
    expect(candidateLine({ ...fiji, city: null, country: null })).toBe("Danam Fiji, no address in ACT!");
  });
});

describe("contactLink (C5) and associationIncludes", () => {
  it("links a contact ACT! associates with no company, and leaves one it associates with any", () => {
    expect(contactLink([])).toEqual({ kind: "link" });
    expect(contactLink([row(B, "Somebody Else")])).toEqual({ kind: "leave", associated: [B] });
  });

  it("finds a company among the associated ones whatever the case of its id", () => {
    expect(associationIncludes([row(A, "Danam")], A.toUpperCase())).toBe(true);
    expect(associationIncludes([row(B, "Danam")], A)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-company-resolve.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/act/company-resolve'`

- [ ] **Step 3: Implement** — `src/lib/act/company-resolve.ts`:

```typescript
// Which ACT! company a PathQuote company is -- decisions C1, C4 and C5 of
// docs/superpowers/specs/2026-10-15-act-write-back-companies.md -- decided on
// what the drain reads from ACT!, before anything is created.
//
// THE ORDER (resolve-company in src/lib/act/outbox-plan.ts):
//
//   1. Company.actCompanyId set: that is the company. Nothing here is asked.
//   2. The quote's ACT! contact's associated companies (fromAssociations):
//      the strongest evidence there is, since ACT!'s own linked contacts hold
//      their company as an association (spec section 3.2). One: that one,
//      whatever its country. Several: narrowed by country. None: on to 3.
//   3. ACT!'s companies by name (fromNameLookup): `startswith` on the first
//      word of the PathQuote name -- two words when the first is shorter than
//      4 characters (companyNamePrefix) -- then only the rows whose name folds
//      to the same identity as PathQuote's (normaliseCompanyName in
//      src/lib/act/company-key.ts: case, punctuation and legal form aside;
//      "Flynt Amtex Inc" and "Flynt Amtex Inc." are one). `eq` alone misses
//      exactly those (spec section 3.1). One: that one. Several: narrowed by
//      country. None: create it (C1).
//
// NARROWED BY COUNTRY (C4): PathQuote's Company.country -- ISO, or legacy
// free text -- against each ACT! company's business-address country, both
// read with normalizeCountryInput (src/lib/countries.ts), the function the
// inbound sync reads ACT!'s countries with. Exactly one left: that one.
// Several, or none in the country, or no PathQuote country to narrow by: the
// quote is HELD for an administrator, who chooses on the quote's page.
//
// A full page of rows is refused before any of this sees it (lookupRows in
// src/lib/act/client.ts), as for every lookup before a create.
//
// Pure, for the suite (vitest.config.ts).

import { normaliseCompanyName } from "@/lib/act/company-key";
import { odataString, sameRecordId } from "@/lib/act/record-write";
import { normalizeCountryInput } from "@/lib/countries";
import { formatCount, plural } from "@/lib/plural";

/** An ACT! company as a lookup or an association list returns it: every field unknown until looked at. */
export type ActCompanyRow = { id?: unknown; name?: unknown; address?: unknown };

type IdRow = ActCompanyRow & { id: string };

/**
 * One ACT! company the drain could not choose between, as stored on
 * Company.actCompanyCandidates and shown to an administrator: its id, its
 * name and where its business address is, as ACT! has them. `takenBy` is
 * the name of the PathQuote client that already carries this ACT! company
 * (Company.actCompanyId is unique), or null.
 */
export type CompanyCandidate = {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  takenBy: string | null;
};

/** Shorter than this, the first word is not enough to ask ACT! for. */
const PREFIX_MIN = 4;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function hasId(row: ActCompanyRow): row is IdRow {
  return typeof row.id === "string" && row.id !== "";
}

/** A word without the punctuation at its ends: "(Fiji)" is "Fiji", "Inc." is "Inc". */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * What the name lookup asks ACT! for: the PathQuote name's first word, or
 * its first two when the first is shorter than PREFIX_MIN ("The Plastics",
 * "3M Australia") -- a word that short would bring back half the list. Each
 * word without the punctuation at its ends, which ACT!'s spelling of the name
 * need not share. Null when the name has no word at all: nothing can be
 * looked up, and the quote is held rather than its company created blind.
 */
export function companyNamePrefix(name: string): string | null {
  const words = name
    .trim()
    .split(/\s+/)
    .map(bare)
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return words[0].length < PREFIX_MIN && words.length > 1 ? `${words[0]} ${words[1]}` : words[0];
}

/**
 * The `$filter` of the name lookup (ActClient.companiesNamedLike):
 * `startswith(name,'<prefix>')`, verified live and case-insensitive (spec
 * section 3.1). A function of its own so that the write preflight
 * (scripts/act-write-preflight.ts, check 11) asks ACT! exactly what the
 * lookup asks.
 */
export function companyNameFilter(prefix: string): string {
  return `startswith(name,${odataString(prefix)})`;
}

/**
 * The rows that are this company by name: their name folds to the same
 * identity as `pathQuoteName` (normaliseCompanyName). A row with no id is
 * left out -- nothing could be stored for it -- and a name that folds to
 * nothing matches nothing.
 */
export function sameNamed(rows: readonly ActCompanyRow[], pathQuoteName: string): IdRow[] {
  const wanted = normaliseCompanyName(pathQuoteName);
  if (wanted === "") return [];
  return rows.filter(hasId).filter((row) => typeof row.name === "string" && normaliseCompanyName(row.name) === wanted);
}

/** A row as stored for the hold. `takenBy` as CompanyCandidate says. */
export function candidateOf(row: IdRow, takenBy: string | null = null): CompanyCandidate {
  const address = record(row.address);
  return {
    id: row.id,
    name: text(row.name) ?? "(no name in ACT!)",
    city: text(address.city),
    country: text(address.country),
    takenBy,
  };
}

/** One company to use, or the candidates to hold the quote with. */
export type CompanyPick = { kind: "use"; id: string } | { kind: "hold"; candidates: CompanyCandidate[] };

function pick(rows: readonly IdRow[], country: string | null): CompanyPick {
  if (rows.length === 1) return { kind: "use", id: rows[0].id };
  const iso = normalizeCountryInput(country);
  const inCountry = iso === null ? [] : rows.filter((row) => normalizeCountryInput(text(record(row.address).country)) === iso);
  if (inCountry.length === 1) return { kind: "use", id: inCountry[0].id };
  return { kind: "hold", candidates: rows.map((row) => candidateOf(row)) };
}

/** What the contact's associated companies say: one to use, several to hold, or `none`, and the name is asked. */
export type AssociationVerdict = CompanyPick | { kind: "none" };

/**
 * The quote's ACT! contact's associated companies
 * (`GET /api/contacts/{id}/associated-companies`), with the PathQuote
 * company's country. See THE ORDER above, 2.
 */
export function fromAssociations(rows: readonly ActCompanyRow[], country: string | null): AssociationVerdict {
  const associated = rows.filter(hasId);
  return associated.length === 0 ? { kind: "none" } : pick(associated, country);
}

/** What the name lookup says: one to use, several to hold, or none of that name, and it is created. */
export type NameVerdict = CompanyPick | { kind: "create" };

/** ACT!'s answer to the name lookup, with the PathQuote name and country. See THE ORDER above, 3. */
export function fromNameLookup(rows: readonly ActCompanyRow[], name: string, country: string | null): NameVerdict {
  const matches = sameNamed(rows, name);
  return matches.length === 0 ? { kind: "create" } : pick(matches, country);
}

/**
 * What create-company does, on the name lookup it makes before EVERY POST:
 *
 *   post  nothing of the name is in ACT! that the decision to create has not
 *         already seen -- `seen` is the candidates an administrator was shown
 *         and chose to create beside (Company.actCompanyCandidates, kept by
 *         "Create a new company in ACT!"), and nothing at all when
 *         resolve-company decided, having found none.
 *   use   exactly one unseen company of the name, or exactly one in the
 *         company's country: what resolve-company would have used. `ours` is
 *         `inFlight` -- Company.actCreateInFlightAt standing, a POST whose
 *         answer was lost -- and then that company is the one the POST made,
 *         which is given its owner like any company PathQuote creates.
 *   hold  several unseen ones that cannot be told apart: every company of the
 *         name, for the administrator to choose from again.
 *
 * So no POST goes out while a company of the name nobody has looked at is in
 * ACT! -- the duplicate a lost answer would otherwise make (A COMPANY CREATE
 * IN FLIGHT in src/lib/act/outbox-plan.ts).
 */
export type CreateVerdict =
  | { kind: "post" }
  | { kind: "use"; id: string; ours: boolean }
  | { kind: "hold"; candidates: CompanyCandidate[] };

export function beforeCompanyCreate(input: {
  rows: readonly ActCompanyRow[];
  name: string;
  country: string | null;
  seen: readonly string[];
  inFlight: boolean;
}): CreateVerdict {
  const matches = sameNamed(input.rows, input.name);
  const unseen = matches.filter((row) => !input.seen.some((id) => sameRecordId(id, row.id)));
  if (unseen.length === 0) return { kind: "post" };
  const chosen = pick(unseen, input.country);
  if (chosen.kind === "use") return { kind: "use", id: chosen.id, ours: input.inFlight };
  return { kind: "hold", candidates: matches.map((row) => candidateOf(row)) };
}

/**
 * Company.actCompanyCandidates as read back: the candidates it holds, and
 * nothing that is not one. A JSON column can hold anything, and what the hold
 * shows an administrator must at least have an id and a name.
 */
export function readCandidates(json: unknown): CompanyCandidate[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item): CompanyCandidate[] => {
    const value = record(item);
    if (typeof value.id !== "string" || value.id === "" || typeof value.name !== "string") return [];
    return [{ id: value.id, name: value.name, city: text(value.city), country: text(value.country), takenBy: text(value.takenBy) }];
  });
}

/** "Danam Fiji, Suva, Fiji": a candidate as the hold and the administrator's list print it. */
export function candidateLine(candidate: CompanyCandidate): string {
  const where = [candidate.city, candidate.country].filter((part): part is string => part !== null).join(", ");
  return `${candidate.name}, ${where === "" ? "no address in ACT!" : where}`;
}

/** How many candidates the sentence names; the rest are counted. */
const LISTED = 5;

/**
 * The blocked reason of a quote held for its company (blockedBy "company"),
 * read by a manager (BLOCKED REASONS ARE READ BY A MANAGER in
 * src/lib/act/outbox-plan.ts): who the candidates are, that PathQuote will
 * not guess, and that an administrator settles it on this page -- whose
 * buttons the manager does not see, so they are not named.
 */
export function companyHeldReason(name: string, candidates: readonly CompanyCandidate[]): string {
  if (candidates.length === 0) {
    return `PathQuote cannot look "${name}" up in ACT! by its name, so it will not create it there blind — an administrator settles it on this quote's page.`;
  }
  const [only] = candidates;
  if (candidates.length === 1 && only.takenBy !== null) {
    return `ACT!'s company "${only.name}" is already PathQuote's client "${only.takenBy}", so PathQuote cannot link it to "${name}" as well — an administrator settles it on this quote's page, or your developer merges the two clients.`;
  }
  const shown = candidates.slice(0, LISTED).map(candidateLine).join("; ");
  const more = candidates.length > LISTED ? `; and ${formatCount(candidates.length - LISTED)} more` : "";
  return `ACT! has ${plural(candidates.length, "company", "companies")} that could be "${name}" (${shown}${more}), and PathQuote will not guess which — an administrator chooses one, or has a new one created, on this quote's page.`;
}

/**
 * Whether link-contact-company associates the contact with the company: only
 * when ACT! associates it with NO company (C5). A contact already associated
 * with any company, this one or another, is left as it is.
 */
export type ContactLink = { kind: "link" } | { kind: "leave"; associated: string[] };

export function contactLink(rows: readonly ActCompanyRow[]): ContactLink {
  return rows.length === 0 ? { kind: "link" } : { kind: "leave", associated: rows.filter(hasId).map((row) => row.id) };
}

/** Whether a list of associated companies holds `companyId`. */
export function associationIncludes(rows: readonly ActCompanyRow[], companyId: string): boolean {
  return rows.some((row) => hasId(row) && sameRecordId(row.id, companyId));
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-company-resolve.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npx eslint src/lib/act/company-resolve.ts tests/act-company-resolve.test.ts`
Expected: PASS (31 tests); `14`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/company-resolve.ts tests/act-company-resolve.test.ts
git commit -m "act: which ACT! company a PathQuote company is, decided before anything is created

The contact's associated companies first -- ACT!'s own linked contacts hold
their company that way -- then ACT!'s companies by name: startswith on the
first word (two when it is under four characters), keeping the rows whose
name folds to PathQuote's identity, since PathQuote and ACT! differ by
punctuation and legal form. One: use it. Several: narrow by country. Still
several, or none in the country: hold the quote for an administrator.

Before every company POST the name is looked up again, and a company of
that name nobody has seen is used or held -- never created beside. That is
what a lost create answer needs, and what an administrator's 'create a new
one' needs too."
```

---

### Task 4: The company's two addresses, as ACT! takes them

**Files:** modify `src/lib/act/write-payloads.ts`, `tests/act-write-payloads.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/act-write-payloads.test.ts` (add `companyAddressPatch, newCompanyBody, streetLines, type CompanyForAct` to its import from `../src/lib/act/write-payloads`, and `import { patchToSend } from "../src/lib/act/record-write";`):

```typescript
describe("the quote's company in ACT!: its business and shipping address (C2, C3)", () => {
  const ITEMS = [{ value: "Australia" }, { value: "Fiji" }, { value: "United States" }];
  const DANAM: CompanyForAct = {
    name: "Danam (Fiji) Pte Limited",
    street: "Lot 12 Kings Road\nValelevu",
    city: "Nasinu",
    state: null,
    postcode: null,
    country: "FJ",
    deliverySameAsMain: true,
    deliveryStreet: null,
    deliveryCity: null,
    deliveryState: null,
    deliveryPostcode: null,
    deliveryCountry: null,
  };
  const BUSINESS = { line1: "Lot 12 Kings Road", line2: "Valelevu", city: "Nasinu", country: "Fiji" };

  it("splits the street into ACT!'s lines, a fourth line and more into line3", () => {
    expect(streetLines("Lot 12 Kings Road\r\n Valelevu ")).toEqual({ line1: "Lot 12 Kings Road", line2: "Valelevu", line3: null });
    expect(streetLines("a\nb\nc\nd")).toEqual({ line1: "a", line2: "b", line3: "c, d" });
    expect(streetLines(null)).toEqual({ line1: null, line2: null, line3: null });
  });

  it("creates the company with its name and both addresses, shipping the main one when the delivery address is the same", () => {
    expect(newCompanyBody(DANAM, ITEMS)).toEqual({ name: "Danam (Fiji) Pte Limited", address: BUSINESS, shippingAddress: BUSINESS });
  });

  it("ships to the delivery address when the company has one", () => {
    const delivered = { ...DANAM, deliverySameAsMain: false, deliveryStreet: "Wharf 3", deliveryCity: "Lautoka", deliveryCountry: "FJ" };
    expect(newCompanyBody(delivered, ITEMS).shippingAddress).toEqual({ line1: "Wharf 3", city: "Lautoka", country: "Fiji" });
  });

  it("ships to the main address when 'different delivery address' is ticked but nothing was entered", () => {
    expect(newCompanyBody({ ...DANAM, deliverySameAsMain: false }, ITEMS).shippingAddress).toEqual(BUSINESS);
  });

  it("leaves the country out when ACT!'s Countries list has no item for it, and an empty address out entirely", () => {
    expect(newCompanyBody({ ...DANAM, country: "NZ" }, ITEMS).address).toEqual({ line1: "Lot 12 Kings Road", line2: "Valelevu", city: "Nasinu" });
    const bare = { ...DANAM, street: null, city: null, country: null };
    expect(newCompanyBody(bare, ITEMS)).toEqual({ name: "Danam (Fiji) Pte Limited" });
  });

  const CURRENT = {
    id: "c0000000-0000-4000-8000-0000000000e1",
    name: "Danam Fiji",
    address: { line1: "Old Rd", line2: "Suva Point", line3: null, city: "Suva", state: "Central", postalCode: "0000", country: "Fiji", latitude: -18.1, longitude: 178.4 },
    shippingAddress: null,
  };

  it("overwrites both addresses from PathQuote, clearing what PathQuote has blank and keeping what ACT! keeps beside them", () => {
    expect(companyAddressPatch(DANAM, ITEMS, CURRENT)).toEqual({
      address: { ...BUSINESS, line3: null, state: null, postalCode: null, latitude: -18.1, longitude: 178.4 },
      shippingAddress: BUSINESS,
    });
  });

  it("never writes the name", () => {
    expect(companyAddressPatch(DANAM, ITEMS, CURRENT)).not.toHaveProperty("name");
  });

  it("keeps ACT!'s lines when PathQuote's street is those lines joined, as the inbound sync joined them", () => {
    const joined = { ...DANAM, street: "Old Rd, Suva Point" };
    expect(companyAddressPatch(joined, ITEMS, CURRENT)?.address).toMatchObject({ line1: "Old Rd", line2: "Suva Point", line3: null });
  });

  it("keeps ACT!'s country when PathQuote's does not resolve to an item", () => {
    expect(companyAddressPatch({ ...DANAM, country: "NZ" }, ITEMS, CURRENT)?.address).toMatchObject({ country: "Fiji" });
  });

  it("leaves alone an address PathQuote has nothing for, and sends no patch when that is both", () => {
    const bare = { ...DANAM, street: null, city: null, country: null };
    expect(companyAddressPatch(bare, ITEMS, CURRENT)).toBeNull();
  });

  it("sends nothing the second time: what it wrote reads back the same", () => {
    const first = companyAddressPatch(DANAM, ITEMS, CURRENT);
    const written = { ...CURRENT, ...first };
    expect(patchToSend(companyAddressPatch(DANAM, ITEMS, written), written)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-write-payloads.test.ts`
Expected: FAIL — `newCompanyBody is not a function` (and its siblings).

- [ ] **Step 3: Implement** — in `src/lib/act/write-payloads.ts`, add to the imports:

```typescript
import { actCountryValue } from "@/lib/act/country-picklist";
import type { ActPicklistItem } from "@/lib/act/types";
```

(`ACT_FIELD` is already imported from `@/lib/act/types`; merge the two into one import line.) Then append at the end of the file:

```typescript
/**
 * A PathQuote company as its ACT! company is written from it: the name, for
 * a create only, and its two addresses (decision C2). Plain values off the
 * Company row; the drain maps them (companyForAct in src/lib/act/drain.ts).
 * `country` and `deliveryCountry` are Company.country's convention: ISO, or
 * legacy free text.
 */
export type CompanyForAct = {
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  deliverySameAsMain: boolean;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPostcode: string | null;
  deliveryCountry: string | null;
};

/** ACT!'s address object (ActAddress in src/lib/act/types.ts), as PathQuote writes it. */
export type CompanyAddressBody = {
  line1?: string;
  line2?: string;
  line3?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
};

/** The body of `POST /api/companies`: the name, and each address PathQuote has anything for. */
export type NewCompanyBody = { name: string; address?: CompanyAddressBody; shippingAddress?: CompanyAddressBody };

/**
 * What write-company lays over the company as read: each address PathQuote
 * has anything for, whole -- built from ACT!'s own object, so what ACT! keeps
 * beside the fields PathQuote writes (latitude, longitude) stays. Never the
 * name (spec section 5; old spec section 6b).
 */
export type CompanyAddressPatch = { address?: Record<string, unknown>; shippingAddress?: Record<string, unknown> };

/** One PathQuote address, its country already the Countries item ACT! will take (or null). */
type OneAddress = { street: string | null; city: string | null; state: string | null; postcode: string | null; country: string | null };

/**
 * PathQuote's street as ACT!'s three lines: one line each, a fourth and more
 * joined into line3 with ", " -- the split scripts/act-company-probe.ts sent
 * and ACT! read back as sent (spec section 3.3). PathQuote holds one street
 * field, typed with line breaks or without.
 */
export function streetLines(street: string | null): { line1: string | null; line2: string | null; line3: string | null } {
  const lines = (street ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { line1: lines[0] ?? null, line2: lines[1] ?? null, line3: lines.length > 2 ? lines.slice(2).join(", ") : null };
}

function filled(value: string | null): string | null {
  return value !== null && value.trim() !== "" ? value.trim() : null;
}

/** Nothing at all to write: no street, city, state or postcode, and no country ACT! lists. */
function blankAddress(address: OneAddress): boolean {
  return [address.street, address.city, address.state, address.postcode].every((v) => filled(v) === null) && address.country === null;
}

/**
 * The two addresses, as C2 has them: the main address is the business
 * address; the delivery address is the shipping address, unless the company
 * has none -- `deliverySameAsMain`, or the box unticked with every delivery
 * field still blank, which is how the quote's own pages decide it
 * (hasDeliveryAddress in src/lib/queries/documents-builder.ts) -- when the
 * main address goes there too. Country as an item of ACT!'s Countries
 * picklist (actCountryValue), or null when none resolves: left out, not
 * guessed.
 */
function companyAddresses(company: CompanyForAct, items: readonly Pick<ActPicklistItem, "value">[]): { business: OneAddress; shipping: OneAddress } {
  const business: OneAddress = {
    street: company.street,
    city: company.city,
    state: company.state,
    postcode: company.postcode,
    country: actCountryValue(company.country, items),
  };
  const hasDelivery =
    !company.deliverySameAsMain &&
    [company.deliveryStreet, company.deliveryCity, company.deliveryPostcode, company.deliveryCountry].some((v) => filled(v) !== null);
  const shipping: OneAddress = hasDelivery
    ? {
        street: company.deliveryStreet,
        city: company.deliveryCity,
        state: company.deliveryState,
        postcode: company.deliveryPostcode,
        country: actCountryValue(company.deliveryCountry, items),
      }
    : business;
  return { business, shipping };
}

/** An address as a create sends it: only the fields PathQuote has. */
function addressBody(address: OneAddress): CompanyAddressBody | undefined {
  if (blankAddress(address)) return undefined;
  const lines = streetLines(address.street);
  const city = filled(address.city);
  const state = filled(address.state);
  const postalCode = filled(address.postcode);
  return {
    ...(lines.line1 ? { line1: lines.line1 } : {}),
    ...(lines.line2 ? { line2: lines.line2 } : {}),
    ...(lines.line3 ? { line3: lines.line3 } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(address.country ? { country: address.country } : {}),
  };
}

/**
 * The company create-company POSTs when ACT! has none of its name: its name
 * as PathQuote has it, and both addresses (C2). No recordManagerID: ACT!
 * ignores it on a create (spec section 3.5); the owner is set by name after
 * (set-owner, OWNER BY NAME in src/lib/act/outbox-plan.ts).
 */
export function newCompanyBody(company: CompanyForAct, items: readonly Pick<ActPicklistItem, "value">[]): NewCompanyBody {
  const { business, shipping } = companyAddresses(company, items);
  const address = addressBody(business);
  const shippingAddress = addressBody(shipping);
  return {
    name: company.name.trim(),
    ...(address ? { address } : {}),
    ...(shippingAddress ? { shippingAddress } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Blank: absent, null or empty -- what ACT! may send for a field it has nothing in. */
function blankValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * A field as the overwrite writes it: PathQuote's value; or, PathQuote having
 * none, ACT!'s own value when that is blank too (absent stays absent, so a
 * record whose answers leave blank fields out still reads back the same), and
 * null when ACT! has one -- PathQuote is the master (C3).
 */
function put(held: Record<string, unknown>, field: string, value: string | null): unknown {
  if (value !== null) return value;
  return blankValue(held[field]) ? held[field] : null;
}

/** Whether ACT!'s lines joined with ", " are PathQuote's street: the street the inbound sync built from them (mapContact in src/lib/act/map.ts). */
function sameStreet(held: Record<string, unknown>, street: string | null): boolean {
  const theirs = [held.line1, held.line2, held.line3]
    .filter((line): line is string => typeof line === "string" && line.trim() !== "")
    .map((line) => line.trim())
    .join(", ");
  const ours = streetLines(street);
  return theirs === [ours.line1, ours.line2, ours.line3].filter((line) => line !== null).join(", ");
}

function overwrite(current: unknown, ours: OneAddress): Record<string, unknown> | undefined {
  if (blankAddress(ours)) return undefined;
  const held = isObject(current) ? current : {};
  const lines = streetLines(ours.street);
  const keepLines = sameStreet(held, ours.street);
  return {
    ...held,
    ...(keepLines
      ? {}
      : {
          line1: put(held, "line1", lines.line1),
          line2: put(held, "line2", lines.line2),
          line3: put(held, "line3", lines.line3),
        }),
    city: put(held, "city", filled(ours.city)),
    state: put(held, "state", filled(ours.state)),
    postalCode: put(held, "postalCode", filled(ours.postcode)),
    ...(ours.country ? { country: ours.country } : {}),
  };
}

/**
 * What write-company changes on the company as read (C3: overwrite from
 * PathQuote, every row, on a company PathQuote did not create as well):
 *
 *   - Each address is written WHOLE, built from ACT!'s own object as read --
 *     record-write.ts's rule for a nested value that is not a reference
 *     (mergeForWrite) -- so latitude, longitude and anything else ACT! keeps
 *     there stays as it was.
 *   - Lines, city, state and postcode are PathQuote's; one PathQuote has
 *     blank clears ACT!'s (put). ACT!'s three lines are kept as they are when
 *     PathQuote's street is exactly them joined with ", ": that street came
 *     from them, and splitting it again would move text between ACT!'s
 *     lines for nothing.
 *   - Country only when PathQuote's resolves to a Countries item; otherwise
 *     ACT!'s stays.
 *   - An address PathQuote has nothing at all for is not written: an empty
 *     PathQuote address never wipes one ACT! holds.
 *
 * Null when neither address is written. A patch that changes nothing on the
 * record is sent as nothing by the client (patchToSend in
 * src/lib/act/record-write.ts), so the second row of a deal writes nothing
 * unless PathQuote's addresses changed.
 */
export function companyAddressPatch(
  company: CompanyForAct,
  items: readonly Pick<ActPicklistItem, "value">[],
  current: Record<string, unknown>,
): CompanyAddressPatch | null {
  const { business, shipping } = companyAddresses(company, items);
  const address = overwrite(current.address, business);
  const shippingAddress = overwrite(current.shippingAddress, shipping);
  if (!address && !shippingAddress) return null;
  return { ...(address ? { address } : {}), ...(shippingAddress ? { shippingAddress } : {}) };
}
```

Also extend the module's opening comment's first sentence list: after "the contact, when ACT! does not have it yet;" add "the company, when ACT! has none of its name, and its two addresses on every row;".

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-write-payloads.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npx eslint src/lib/act/write-payloads.ts tests/act-write-payloads.test.ts`
Expected: PASS (the 11 new tests with the rest); `14`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/write-payloads.ts tests/act-write-payloads.test.ts
git commit -m "act: a company's business and shipping address, as ACT! is to hold them

PathQuote's main address is the business address and its delivery address
the shipping address -- the main one again when there is no separate
delivery address (C2). On a company already in ACT! both are overwritten
from PathQuote (C3), each nested object written whole from ACT!'s own read
so latitude and longitude stay. The name is never written.

Two rules beyond the spec: an address PathQuote has nothing for is left as
ACT! has it, so an empty PathQuote company never wipes a real ACT! address;
and ACT!'s three lines are kept when PathQuote's street is exactly them
joined, which is how the inbound sync built it."
```

---

### Task 5: The client: companies, associations, owners

**Files:** modify `src/lib/act/types.ts`, `src/lib/act/client.ts`, `tests/act-write-preflight.test.ts`

I/O only. The architecture rule keeps it untested apart from the reader guard below, as Task 5 of the quotes plan was.

- [ ] **Step 1: Extend the reader guard** — in `tests/act-write-preflight.test.ts`, the test "has a GET for each of its four members and nothing else" iterates a list of write methods; add `"createCompany", "updateCompany", "setRecordManager", "associateContactCompany", "associateOpportunityCompany"` to it. It passes before and after: it guards that the read-only `ActReader` never gains them.

- [ ] **Step 2: Add `ActCompany`** — in `src/lib/act/types.ts`, after `ActContact`:

```typescript
/**
 * One company (`act.web.api.models.Companies.Company` in swagger), trimmed to
 * the fields the write-back reads or writes. At runtime it carries every
 * field ACT! sent -- an update sends them back (ActClient's `update`). Its
 * addresses come back with `latitude` and `longitude` (a number or null),
 * which PathQuote never writes or compares (spec section 3.3). Nullable for
 * the reason ActUser's fields are.
 */
export type ActCompany = {
  id: string;
  name: string | null;
  address: (ActAddress & { latitude?: number | null; longitude?: number | null }) | null;
  shippingAddress: (ActAddress & { latitude?: number | null; longitude?: number | null }) | null;
  recordManager: string | null;
  recordManagerID: string | null;
  created: string | null;
  edited: string | null;
};
```

and in `ActContactPatch`'s comment replace "naming `recordManager` among those never sent." with "naming `recordManager` among those never sent -- the owner is set by its own partial PATCH instead (ActClient.setRecordManager; OWNER BY NAME in src/lib/act/outbox-plan.ts)."

- [ ] **Step 3: The client** — in `src/lib/act/client.ts`:

Imports: add `ActCompany` to the `@/lib/act/types` import; add `CompanyAddressPatch, NewCompanyBody` to the `@/lib/act/write-payloads` import; add

```typescript
import { companyNameFilter } from "@/lib/act/company-resolve";
import type { OwnerPatch } from "@/lib/act/record-owner";
```

In `parse`, replace `if (method === "PATCH") return null;` with

```typescript
    // A PATCH's answer is not read (see `update`), nor a PUT's: an
    // association is read back by its own GET.
    if (method === "PATCH" || method === "PUT") return null;
```

Beside `contactPath`:

```typescript
function companyPath(id: string): string {
  return `/api/companies/${encodeURIComponent(id)}`;
}
```

In the `ActClient` class, after `updateContact`:

```typescript
  /**
   * The rows of an association list: `GET {path}` with NO query, exactly the
   * request scripts/act-company-probe.ts made and ACT! answered (2026-10-16).
   * `$top` has not been tried on these, and one record's companies are a
   * handful, so nothing is paged and nothing is cut short.
   */
  private async associationRows<T>(path: string): Promise<T[]> {
    return unwrapRows<T>(await this.get(path), path);
  }

  /**
   * ACT!'s companies whose name starts with `prefix`, for resolve-company
   * and create-company (fromNameLookup, beforeCompanyCreate in
   * src/lib/act/company-resolve.ts): `GET /api/companies?$filter=startswith(name,'...')`
   * with `$top` LOOKUP_TOP, a full page refused (`lookupRows`). Verified
   * live: startswith is honoured and case-insensitive (spec section 3.1).
   * NO FALLBACK when ACT! refuses the filter, unlike opportunitiesNamed:
   * there is no smaller list of companies to look through, and reading all
   * of them before every create is what the filter is for. A refusal holds
   * the row as any refused request does; check 11 of the write preflight
   * says beforehand whether the filter works.
   */
  async companiesNamedLike(prefix: string): Promise<ActCompany[]> {
    return this.lookupRows<ActCompany>("/api/companies", companyNameFilter(prefix));
  }

  /** One company: `GET /api/companies/{id}`. */
  async getCompany(id: string): Promise<ActCompany> {
    return (await this.getRecord(companyPath(id), id)) as unknown as ActCompany;
  }

  /**
   * Create one company: `POST /api/companies` with its name and two
   * addresses (newCompanyBody in src/lib/act/write-payloads.ts), answered
   * 201 with the record (spec section 3.3). Sent once, like every create,
   * and only after the name lookup has found nothing it has not seen
   * (beforeCompanyCreate in src/lib/act/company-resolve.ts).
   */
  async createCompany(body: NewCompanyBody): Promise<ActCompany> {
    return (await this.create("/api/companies", body, companyPath)) as unknown as ActCompany;
  }

  /**
   * Change a company: read it, ask `decide` on that read
   * (companyAddressPatch), and `PATCH /api/companies/{id}` the whole record
   * back. See `update`: whole records are how scripts/act-fix-country-*.py
   * wrote production companies.
   */
  async updateCompany(id: string, decide: (current: ActCompany) => CompanyAddressPatch | null): Promise<Updated<ActCompany>> {
    return this.update(companyPath(id), id, decide);
  }

  /** The companies a contact is associated with: `GET /api/contacts/{id}/associated-companies`. */
  async contactCompanies(contactId: string): Promise<ActCompany[]> {
    return this.associationRows<ActCompany>(`${contactPath(contactId)}/associated-companies`);
  }

  /** The companies an opportunity is associated with: `GET /api/opportunities/{id}/associated-companies`. */
  async opportunityCompanies(opportunityId: string): Promise<ActCompany[]> {
    return this.associationRows<ActCompany>(`${opportunityPath(opportunityId)}/associated-companies`);
  }

  /**
   * Associate a contact with a company:
   * `PUT /api/contacts/{contactId}/associated-companies/{companyId}`, no body
   * -- how ACT!'s own linked contacts hold their company; their `company`
   * text and `companyID` are not changed by it (spec section 3.2). The
   * answer is not read: the caller reads the association back.
   */
  async associateContactCompany(contactId: string, companyId: string): Promise<void> {
    await this.request(`${contactPath(contactId)}/associated-companies/${encodeURIComponent(companyId)}`, { method: "PUT" });
  }

  /** Associate an opportunity with a company: `PUT /api/opportunities/{id}/associated-companies/{companyId}` (spec section 3.4). As above. */
  async associateOpportunityCompany(opportunityId: string, companyId: string): Promise<void> {
    await this.request(`${opportunityPath(opportunityId)}/associated-companies/${encodeURIComponent(companyId)}`, {
      method: "PUT",
    });
  }

  /**
   * Set a record's owner by name: read it, ask `decide` on that read
   * (ownerPatch in src/lib/act/record-owner.ts -- nothing when it already
   * reads so), `PATCH /api/{collection}/{id}` with `{ recordManager, id }`
   * and NOTHING ELSE, then read it again.
   *
   * PARTIAL, unlike every other PATCH here (`update`). The partial body is
   * the one ACT! was seen to take, on a contact, a company and an
   * opportunity alike (`npm run act:company-probe -- --owner-all`,
   * 2026-10-16). The whole record would carry the login's recordManagerID
   * beside the new name, a combination nobody has tried; and there is no
   * nested object in this patch for a partial write to blank.
   */
  async setRecordManager(
    collection: "contacts" | "companies" | "opportunities",
    id: string,
    decide: (current: ActRecordJson & { id: string }) => OwnerPatch | null,
  ): Promise<Updated<ActRecordJson & { id: string }>> {
    const path = `/api/${collection}/${encodeURIComponent(id)}`;
    const current = await this.getRecord(path, id);
    const patch = patchToSend(decide(current), current);
    if (!patch) return { written: false, record: current };
    await this.request(path, { method: "PATCH", body: { ...patch, id } });
    return { written: true, record: await this.getRecord(path, id) };
  }
```

In the `users()` comment, replace "the client writes only Histories, opportunities, their product lines and contacts, and the users endpoint's POST is not reachable from here." with "the client writes Histories, opportunities and their product lines, contacts and companies, and the associations between them, and the users endpoint's POST is not reachable from here."

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test`
Expected: no app type errors; `14`; lint clean; every test passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/types.ts src/lib/act/client.ts tests/act-write-preflight.test.ts
git commit -m "act: the client can find, create and write companies, associate records with them, and set an owner by name

Every request is the shape the company probe sent and ACT! answered on
2026-10-16: startswith on /api/companies, a POST with name and both
addresses, a PUT with no body on associated-companies, and a partial PATCH
of recordManager. The owner PATCH is partial on purpose: that is the body
ACT! took on all three record types, where a whole record would send the
login's recordManagerID beside the new name.

The company filter has no fallback: there is no smaller list to look
through. A refusal holds the row; the preflight says beforehand."
```

---

### Task 6: The schema

**Files:** modify `prisma/schema.prisma`, `src/lib/act/outbox-sql.ts`, `tests/act-outbox-sql.test.ts`; create `prisma/migrations/z71_act_write_back_companies/migration.sql`

- [ ] **Step 1: Write the failing test** — in `tests/act-outbox-sql.test.ts`, in "on a take-over, repoints the revision, adds 1 to generation and resets the row's own progress", add `'"companyWrittenAt"': "NULL",` after the `productLineSkippedAt` entry; and replace the last test's name and file:

```typescript
  it("is the statement the latest migration to change it quotes: z71_act_write_back_companies", () => {
    const migration = readFileSync(
      path.join(__dirname, "../prisma/migrations/z71_act_write_back_companies/migration.sql"),
      "utf8",
    ).split("\n");
```

(the rest of that test unchanged). z65 is applied in production and is not edited: Prisma records each migration's checksum.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-outbox-sql.test.ts`
Expected: FAIL — the assignments lack `"companyWrittenAt"`, and `ENOENT` for z71.

- [ ] **Step 3: The columns** — in `prisma/schema.prisma`:

In `model Company`, after `actSnapshot        ActSnapshot?`:

```prisma
  /// The ACT! companies the drain found that could be this one when it could
  /// not tell which is -- several of its name, none or several of them in its
  /// country -- or the one it found is already another PathQuote company's:
  /// [{ id, name, city, country, takenBy }] (CompanyCandidate in
  /// src/lib/act/company-resolve.ts), written with actCompanyHeldAt and shown
  /// to an administrator on the quote's ACT! card. KEPT when the
  /// administrator chooses "Create a new company in ACT!": they are the
  /// companies seen and passed over, and create-company looks for any OTHER
  /// company of the name before it POSTs. Cleared once actCompanyId is set.
  actCompanyCandidates  Json?
  /// When the drain held this company for an administrator. While it is set
  /// and actCompanyId is null, the outbox planner blocks every quote on the
  /// company that needs it (blockedBy "company"). Cleared by the
  /// administrator's choice, which is guarded on it. See THE COMPANY in
  /// src/lib/act/outbox-plan.ts.
  actCompanyHeldAt      DateTime?
  /// When it was decided that PathQuote creates this company in ACT!:
  /// resolve-company found none of its name, or an administrator chose
  /// "Create a new company in ACT!". A column rather than a value in
  /// actCompanyId, which is unique and is sent to ACT! as an id. While set
  /// and actCompanyId is null, the planner plans create-company. Cleared
  /// when actCompanyId is stored.
  actCreateChosenAt     DateTime?
  /// Set by the drain, and committed, before it POSTs this company; cleared
  /// in the update that stores actCompanyId, or when the POST made nothing
  /// (createMadeNothing in src/lib/act/client.ts). Left set when the answer
  /// was lost: the next create-company then looks the name up first and uses
  /// the company the POST made, or holds for an administrator -- it never
  /// POSTs while a company of that name nobody has seen is in ACT!. See A
  /// COMPANY CREATE IN FLIGHT in src/lib/act/outbox-plan.ts.
  actCreateInFlightAt   DateTime?
  /// The ACT! user (User.actUserId) this company is still to be given as
  /// owner, by name: the author of the quote whose row created it, when they
  /// have one. Set with actCompanyId by the create -- or by an adoption after
  /// the create's own answer was lost -- and cleared by set-owner. Never set
  /// for a company PathQuote found rather than made. See OWNER BY NAME in
  /// src/lib/act/outbox-plan.ts.
  actOwnerPendingUserId String?
```

In `model Contact`, after `actCreateInFlightAt DateTime?`:

```prisma
  /// The ACT! user this contact is still to be given as owner, by name: the
  /// author of the quote whose row created it, when they have one. Set in
  /// the update that stores actContactId after a create; cleared by
  /// set-owner. Never set for a contact ACT! already had. See OWNER BY NAME
  /// in src/lib/act/outbox-plan.ts.
  actOwnerPendingUserId String?
  /// The ACT! company (Company.actCompanyId) link-contact-company last
  /// settled this contact for: associated it with that company, or found it
  /// associated with a company already and left it (decision C5). The step
  /// is due while this differs from the quote's company's ACT! id.
  actCompanyLinkedFor   String?
```

In `model Document`, after `actOpportunityWonAt     DateTime?`:

```prisma
  /// The ACT! user the deal's opportunity is still to be given as owner, by
  /// name: the quote's author, when they have one. Set with
  /// actOpportunityId when create-opportunity creates the opportunity or
  /// adopts the one its lookup found (its own lost create); cleared by
  /// set-owner. An opportunity created before owners were set by name keeps
  /// the owner it has.
  actOpportunityOwnerPendingUserId String?
  /// The ACT! company the deal's opportunity is associated with, as
  /// associate-opportunity-company found or made it. Due while this differs
  /// from the quote's company's actCompanyId -- which is how an opportunity
  /// created before companies were written (Danam's) gets its company.
  actOpportunityCompanyId          String?
```

In `model ActOutbox`, after `productLineSkippedAt DateTime?`:

```prisma
  /// When this row's write-company wrote the quote's company's business and
  /// shipping address into ACT! (or found them already so). On the row,
  /// because PathQuote is the master for those two addresses and writes them
  /// at every finalise, signature and acceptance (decision C3): a take-over
  /// clears it with opportunityActId (enqueueStatement in
  /// src/lib/act/outbox-sql.ts), so each event writes them again.
  companyWrittenAt     DateTime?
```

- [ ] **Step 4: The migration** — generate the DDL rather than typing it:

```bash
git show HEAD:prisma/schema.prisma > /tmp/schema-main.prisma
npx prisma migrate diff --from-schema /tmp/schema-main.prisma --to-schema prisma/schema.prisma --script
```

It prints exactly the four `ALTER TABLE`s below; if it prints anything else, stop and find out why. (The usual cause: another change to `schema.prisma` is uncommitted in the working tree — the performance audit's indexes were, when this plan was written. Commit or stash it first: this migration must hold this task's columns and nothing else.) Create `prisma/migrations/z71_act_write_back_companies/migration.sql`:

```sql
-- The company write-back and owners by name
-- (docs/superpowers/specs/2026-10-15-act-write-back-companies.md): the
-- stored facts the outbox planner (src/lib/act/outbox-plan.ts) reads for its
-- six new steps, each written by the step named beside it.
--
--   Company.actCompanyCandidates     the drain, holding the company: the ACT!
--   Company.actCompanyHeldAt         companies it could be, and when -- every
--                                    quote on it held for an administrator
--   Company.actCreateChosenAt        resolve-company (none of its name) or an
--                                    administrator: create-company is due
--   Company.actCreateInFlightAt      create-company, around its POST
--   Company.actOwnerPendingUserId    the company create; set-owner clears it
--   Contact.actOwnerPendingUserId    the contact create; set-owner clears it
--   Contact.actCompanyLinkedFor      link-contact-company
--   Document.actOpportunityOwnerPendingUserId
--                                    the opportunity create; set-owner
--   Document.actOpportunityCompanyId associate-opportunity-company
--   ActOutbox.companyWrittenAt       write-company, once per row; a take-over
--                                    clears it
--
-- Company.actCompanyId (z60_act_sync) is where resolve-company and
-- create-company store their result: no new column for it.
--
-- THE ENQUEUE CHANGES WITH THIS MIGRATION: a take-over now clears
-- companyWrittenAt too, so a finalise, a signature or an acceptance that
-- takes the unfinished row over writes the company's addresses again. This
-- is the statement enqueueStatement (src/lib/act/outbox-sql.ts) builds,
-- layout aside -- tests/act-outbox-sql.test.ts holds the two together, as it
-- held z65_act_outbox's copy until now (z65 is applied in production and is
-- not edited: Prisma keeps each migration's checksum):
--   INSERT INTO "ActOutbox"
--     ("id", "documentId", "quoteRevisionId", "generation", "nextAttemptAt", "createdAt", "updatedAt")
--   VALUES ($1, $2, $3, 0, $4, $5, $6)
--   ON CONFLICT ("documentId") WHERE "completedAt" IS NULL DO UPDATE SET
--     "quoteRevisionId" = EXCLUDED."quoteRevisionId",
--     "generation" = "ActOutbox"."generation" + 1,
--     "opportunityActId" = NULL,
--     "productLineSkippedAt" = NULL,
--     "companyWrittenAt" = NULL,
--     "blockedReason" = NULL,
--     "blockedBy" = NULL,
--     "lastError" = NULL,
--     "attempts" = 0,
--     "nextAttemptAt" = EXCLUDED."nextAttemptAt",
--     "updatedAt" = EXCLUDED."updatedAt"
-- (z65's comment explains every other line of it.)
--
-- Additive only: ten nullable columns with no default, no index, and no
-- existing row written -- AGENTS.md's rule for production. Each ADD COLUMN
-- takes ACCESS EXCLUSIVE on its table for a catalog change only (no rewrite),
-- one statement per table: ActOutbox, Company, Contact, Document. While one
-- waits for its lock, later queries on that table queue behind it -- on
-- Contact, the inbound sync's included -- so deploy outside the 03:00 sync.
-- `prisma migrate deploy` runs each statement in a transaction of its own
-- (z65's comment says how that was tried).

-- AlterTable
ALTER TABLE "ActOutbox" ADD COLUMN     "companyWrittenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "actCompanyCandidates" JSONB,
ADD COLUMN     "actCompanyHeldAt" TIMESTAMP(3),
ADD COLUMN     "actCreateChosenAt" TIMESTAMP(3),
ADD COLUMN     "actCreateInFlightAt" TIMESTAMP(3),
ADD COLUMN     "actOwnerPendingUserId" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "actCompanyLinkedFor" TEXT,
ADD COLUMN     "actOwnerPendingUserId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "actOpportunityCompanyId" TEXT,
ADD COLUMN     "actOpportunityOwnerPendingUserId" TEXT;
```

- [ ] **Step 5: The take-over** — in `src/lib/act/outbox-sql.ts`, in `enqueueStatement`, after `"productLineSkippedAt" = NULL,` add the line `      "companyWrittenAt" = NULL,`; and in its comment, after "opportunityActId and productLineSkippedAt, which say this row's opportunity and line steps are done," add "companyWrittenAt, which says this row has written the company's addresses (decision C3: every event writes them),"; and change "The migration's comment quotes this statement" to "The latest migration to change it, z71_act_write_back_companies, quotes this statement in its comment".

- [ ] **Step 6: Verify**

```bash
npx prisma generate
npx vitest run tests/act-outbox-sql.test.ts
npx prisma migrate deploy            # against the LOCAL database only
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test
```

Expected: PASS; "No difference detected", exit 0 (the CI step "Migrations reproduce schema.prisma"); `14`; clean; all tests pass. Check `DATABASE_URL` is localhost before `migrate deploy`.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/z71_act_write_back_companies/migration.sql src/lib/act/outbox-sql.ts tests/act-outbox-sql.test.ts
git commit -m "act: where the company write-back and the owners keep their progress

Ten nullable columns, nothing rewritten. On the Company, shared by every
quote on it: whether to create it, the create in flight, the candidates an
administrator chooses between and when it was held, and the owner it is
still to be given. On the Contact: its pending owner and the company its
link was settled for. On the Document: the opportunity's pending owner and
its company. On the row: when it wrote the company's addresses -- every
event writes them, so a take-over clears it.

z65 is applied and keeps its checksum: the enqueue statement's quoted copy
moves to z71."
```

---

### Task 7: The planner's six steps, and owners by name in the drain

**Files:** modify `src/lib/act/outbox-plan.ts`, `src/lib/act/drain-rules.ts`, `src/lib/act/drain.ts`, `src/lib/act/merge.ts`, `tests/act-outbox-plan.test.ts`, `tests/act-drain-rules.test.ts`

The planner gets every new step (they are one sequence and one contract). The drain gets the owner step, and hands the planner `company: null` until Task 10, so no company step is planned before an administrator can settle a company hold (Tasks 8–9).

- [ ] **Step 1: Bring the test helpers up to the new shapes** — in `tests/act-outbox-plan.test.ts`:

```typescript
const nothingDone: OutboxProgress = { opportunityActId: null, productLineSkippedAt: null, createInFlight: null, companyWrittenAt: null };
```

and in `quoteState`'s object, after `actOpportunityWonAt: null,`:

```typescript
  contactOwnerPendingUserId: null,
  contactCompanyLinkedFor: null,
  company: null,
  opportunityOwnerPendingUserId: null,
  actOpportunityCompanyId: null,
```

The same two edits in `tests/act-drain-rules.test.ts` (its `nothingDone` at line 330 and its `quote` helper). Every existing test keeps its meaning: no company, nothing pending.

- [ ] **Step 2: Write the failing tests** — append to `tests/act-outbox-plan.test.ts` (add `type QuoteCompany` to the import from `../src/lib/act/outbox-plan`, and `import { companyHeldReason, type CompanyCandidate } from "../src/lib/act/company-resolve";`):

```typescript
const ACT_COMPANY = "c0000000-0000-0000-0000-0000000000e0";
const ACT_AUTHOR = "c0000000-0000-0000-0000-0000000000f0";
const COMPANY_AT = new Date("2026-10-16T02:00:00.000Z");
const CANDIDATE_SUVA: CompanyCandidate = { id: "c0000000-0000-0000-0000-0000000000e1", name: "Danam Fiji", city: "Suva", country: "Fiji", takenBy: null };
const CANDIDATE_LAUTOKA: CompanyCandidate = { ...CANDIDATE_SUVA, id: "c0000000-0000-0000-0000-0000000000e2", city: "Lautoka" };

const company = (overrides: Partial<QuoteCompany> = {}): QuoteCompany => ({
  name: "Danam (Fiji) Pte Limited",
  actCompanyId: null,
  heldAt: null,
  candidates: [],
  createChosenAt: null,
  ownerPendingUserId: null,
  ...overrides,
});
/** The company found, and the contact's link settled for it. */
const settledCompany: Partial<QuoteState> = { company: company({ actCompanyId: ACT_COMPANY }), contactCompanyLinkedFor: ACT_COMPANY };
/** This row has written the company's addresses. */
const companyWritten: OutboxProgress = { ...nothingDone, companyWrittenAt: COMPANY_AT };

describe("nextStep: owners by name (O1)", () => {
  it("gives a contact it has just created its owner before anything else", () => {
    expect(nextStep(nothingDone, noHistory, quoteState({ contactOwnerPendingUserId: ACT_AUTHOR }))).toEqual({
      kind: "set-owner",
      record: "contact",
    });
  });

  it("gives the opportunity its owner after the opportunity step, before its line", () => {
    const state = quoteState({ actOpportunityId: ACT_OPPORTUNITY, opportunityOwnerPendingUserId: ACT_AUTHOR });
    expect(nextStep(opportunityStepDone, noHistory, state)).toEqual({ kind: "set-owner", record: "opportunity" });
  });

  it("never plans a create again for an owner still pending: the record's id is stored", () => {
    const state = quoteState({ actOpportunityId: ACT_OPPORTUNITY, opportunityOwnerPendingUserId: ACT_AUTHOR });
    expect(nextStep(nothingDone, noHistory, state)).toEqual({ kind: "update-opportunity" });
  });

  it("finishes an owner a journaled row still owes, then is done", () => {
    expect(nextStep(nothingDone, journaled, finishedDeal({ opportunityOwnerPendingUserId: ACT_AUTHOR }))).toEqual({
      kind: "set-owner",
      record: "opportunity",
    });
    expect(nextStep(nothingDone, journaled, finishedDeal())).toEqual({ kind: "done" });
  });
});

describe("nextStep: the quote's company", () => {
  it("skips every company step for a quote with no company", () => {
    expect(nextStep(nothingDone, noHistory, quoteState())).toEqual({ kind: "create-opportunity" });
  });

  it("resolves the company after the contact and its owner, and before the opportunity", () => {
    expect(nextStep(nothingDone, noHistory, quoteState({ contact: pathQuoteOnlyContact, company: company() }))).toEqual({
      kind: "create-contact",
    });
    expect(nextStep(nothingDone, noHistory, quoteState({ company: company(), contactOwnerPendingUserId: ACT_AUTHOR }))).toEqual({
      kind: "set-owner",
      record: "contact",
    });
    expect(nextStep(nothingDone, noHistory, quoteState({ company: company() }))).toEqual({ kind: "resolve-company" });
  });

  it("creates it only once resolve-company, or an administrator, has decided to", () => {
    expect(nextStep(nothingDone, noHistory, quoteState({ company: company({ createChosenAt: COMPANY_AT }) }))).toEqual({
      kind: "create-company",
    });
  });

  it("holds the quote for an administrator while its company is held, naming the candidates, as the company's blocker", () => {
    const held = company({ heldAt: COMPANY_AT, candidates: [CANDIDATE_SUVA, CANDIDATE_LAUTOKA] });
    expect(nextStep(nothingDone, noHistory, quoteState({ company: held }))).toEqual({
      kind: "blocked",
      reason: companyHeldReason(held.name, held.candidates),
      by: "company",
    });
  });

  it("holds a journaled deal's row too while its company is held: the company is not the revision's", () => {
    const held = company({ heldAt: COMPANY_AT, candidates: [CANDIDATE_SUVA, CANDIDATE_LAUTOKA] });
    expect(nextStep(nothingDone, journaled, finishedDeal({ company: held })).kind).toBe("blocked");
  });

  it("then the company's owner, its addresses and the contact's link, in that order", () => {
    expect(nextStep(nothingDone, noHistory, quoteState({ company: company({ actCompanyId: ACT_COMPANY, ownerPendingUserId: ACT_AUTHOR }) }))).toEqual({
      kind: "set-owner",
      record: "company",
    });
    expect(nextStep(nothingDone, noHistory, quoteState({ company: company({ actCompanyId: ACT_COMPANY }) }))).toEqual({
      kind: "write-company",
    });
    expect(nextStep(companyWritten, noHistory, quoteState({ company: company({ actCompanyId: ACT_COMPANY }) }))).toEqual({
      kind: "link-contact-company",
    });
    expect(nextStep(companyWritten, noHistory, quoteState(settledCompany))).toEqual({ kind: "create-opportunity" });
  });

  it("writes the addresses on every row: a fresh row has not written them (C3)", () => {
    expect(nextStep(nothingDone, noHistory, quoteState(settledCompany))).toEqual({ kind: "write-company" });
  });

  it("links the contact again for a different company, and not for the same one in other capitals", () => {
    const moved = quoteState({ ...settledCompany, contactCompanyLinkedFor: "c0000000-0000-0000-0000-0000000000e9" });
    expect(nextStep(companyWritten, noHistory, moved)).toEqual({ kind: "link-contact-company" });
    const shouting = quoteState({ ...settledCompany, contactCompanyLinkedFor: ACT_COMPANY.toUpperCase() });
    expect(nextStep(companyWritten, noHistory, shouting)).toEqual({ kind: "create-opportunity" });
  });

  it("associates the opportunity with the company after the opportunity step and its owner, before the line", () => {
    const state = quoteState({ ...settledCompany, actOpportunityId: ACT_OPPORTUNITY });
    const done = { ...companyWritten, opportunityActId: ACT_OPPORTUNITY };
    expect(nextStep(done, noHistory, { ...state, opportunityOwnerPendingUserId: ACT_AUTHOR })).toEqual({
      kind: "set-owner",
      record: "opportunity",
    });
    expect(nextStep(done, noHistory, state)).toEqual({ kind: "associate-opportunity-company" });
    expect(nextStep(done, noHistory, { ...state, actOpportunityCompanyId: ACT_COMPANY })).toEqual({
      kind: "write-product-line",
      line: "create",
    });
  });

  it("gives a deal journaled before companies were written its company at its next event (Danam)", () => {
    const danam = finishedDeal({ company: company(), signingStatus: "SIGNED", actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(nothingDone, journaled, danam)).toEqual({ kind: "resolve-company" });
    const found = { ...danam, company: company({ actCompanyId: ACT_COMPANY }), contactCompanyLinkedFor: ACT_COMPANY };
    expect(nextStep(nothingDone, journaled, found)).toEqual({ kind: "write-company" });
    expect(nextStep(companyWritten, journaled, found)).toEqual({ kind: "associate-opportunity-company" });
    expect(nextStep(companyWritten, journaled, { ...found, actOpportunityCompanyId: ACT_COMPANY })).toEqual({ kind: "done" });
  });

  it("leaves a journaled row whose contact is not in ACT! done, company or not, as before", () => {
    expect(nextStep(nothingDone, journaled, finishedDeal({ contact: null, company: company() }))).toEqual({ kind: "done" });
    expect(nextStep(nothingDone, journaled, finishedDeal({ contact: pathQuoteOnlyContact, company: company() }))).toEqual({
      kind: "done",
    });
  });

  it("puts the company before a deal event: the win waits for the company's steps", () => {
    const accepted = finishedDeal({ company: company(), signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT });
    expect(nextStep(nothingDone, journaled, accepted)).toEqual({ kind: "resolve-company" });
  });
});
```

And in `tests/act-drain-rules.test.ts`: add `"set-owner", "resolve-company", "create-company", "write-company", "link-contact-company", "associate-opportunity-company"` to the `kinds` list at line ~236; and append:

```typescript
describe("a quote held for its company (BLOCKED_BY.company)", () => {
  const held = { blockedReason: "ACT! has 2 companies that could be ...", blockedBy: BLOCKED_BY.company };

  it("stores the planner's company hold as BLOCKED_BY.company", () => {
    expect(plannerBlockedBy({ kind: "blocked", reason: held.blockedReason, by: "company" })).toBe(BLOCKED_BY.company);
  });

  it("is kept while the company is held, and unblocked once an administrator has chosen", () => {
    expect(replanBlocked(held, { kind: "blocked", reason: held.blockedReason, by: "company" })).toEqual({ kind: "keep" });
    expect(replanBlocked(held, { kind: "write-company" })).toEqual({ kind: "unblock" });
    expect(replanBlocked(held, { kind: "create-company" })).toEqual({ kind: "unblock" });
  });

  it("is re-blocked with the planner's sentence when the candidates changed", () => {
    expect(replanBlocked(held, { kind: "blocked", reason: "new sentence", by: "company" })).toEqual({
      kind: "reblock",
      reason: "new sentence",
      by: BLOCKED_BY.company,
    });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run tests/act-outbox-plan.test.ts tests/act-drain-rules.test.ts`
Expected: FAIL — the new cases (`set-owner` returned as `create-opportunity`, `BLOCKED_BY.company` undefined, …); every existing case still passes.

- [ ] **Step 4: The planner** — in `src/lib/act/outbox-plan.ts`:

Imports, after the header (the file has none today):

```typescript
import { companyHeldReason, type CompanyCandidate } from "@/lib/act/company-resolve";
import type { OwnerRecord } from "@/lib/act/record-owner";
import { sameRecordId } from "@/lib/act/record-write";
```

Types — `OutboxProgress` gains:

```typescript
  /**
   * ActOutbox.companyWrittenAt: set once this row's write-company has
   * written the quote's company's two addresses (decision C3: every row
   * writes them). A take-over clears it. See THE COMPANY.
   */
  companyWrittenAt: Date | null;
```

Before `QuoteState`:

```typescript
/** The quote's company (Document.companyId), reduced to what the plan depends on. */
export type QuoteCompany = {
  /** Company.name, for the hold's sentence. */
  name: string;
  /** Company.actCompanyId: its ACT! company, found or created; null until then. */
  actCompanyId: string | null;
  /** Company.actCompanyHeldAt: set while the company is held for an administrator. */
  heldAt: Date | null;
  /** Company.actCompanyCandidates, read (readCandidates): what the hold names. */
  candidates: readonly CompanyCandidate[];
  /** Company.actCreateChosenAt: create-company is due. */
  createChosenAt: Date | null;
  /** Company.actOwnerPendingUserId: the ACT! user it is still to be owned by. */
  ownerPendingUserId: string | null;
};
```

`QuoteState` gains, after `actOpportunityWonAt`:

```typescript
  /** Contact.actOwnerPendingUserId of the quote's contact: the owner it is still to be given (OWNER BY NAME). */
  contactOwnerPendingUserId: string | null;
  /** Contact.actCompanyLinkedFor of the quote's contact: the ACT! company its link was settled for. */
  contactCompanyLinkedFor: string | null;
  /** The quote's company, or null: a quote with none skips every company step. */
  company: QuoteCompany | null;
  /** Document.actOpportunityOwnerPendingUserId: the owner the deal's opportunity is still to be given. */
  opportunityOwnerPendingUserId: string | null;
  /** Document.actOpportunityCompanyId: the ACT! company the deal's opportunity is associated with. */
  actOpportunityCompanyId: string | null;
```

`OutboxStep`: add, after `| { kind: "create-contact" }`,

```typescript
  /** The record PathQuote just created given its author as owner, by name. See OWNER BY NAME. */
  | { kind: "set-owner"; record: OwnerRecord }
  /** Find the quote's ACT! company, decide to create it, or hold it. See THE COMPANY. */
  | { kind: "resolve-company" }
  /** POST the company, after a lookup by name. See A COMPANY CREATE IN FLIGHT. */
  | { kind: "create-company" }
  /** The company's business and shipping address, overwritten from PathQuote (C3). */
  | { kind: "write-company" }
  /** The contact associated with the company, when ACT! associates it with none (C5). */
  | { kind: "link-contact-company" }
  /** The deal's opportunity associated with the company, when it is not. */
  | { kind: "associate-opportunity-company" }
```

and change the blocked member to `| { kind: "blocked"; reason: string; by?: "contact" | "company" };`, its comment adding: "`by` is \"company\" -- BLOCKED_BY.company -- on the block that holds the quote for its company (companyHeldReason in src/lib/act/company-resolve.ts)."

Helpers, above `nextStep`:

```typescript
/** Two ACT! ids naming one record; null names none. */
function sameId(a: string | null, b: string): boolean {
  return a !== null && sameRecordId(a, b);
}

/**
 * The company's steps, in THE COMPANY's order, or null when the company
 * needs nothing more from this row.
 */
function companyStep(progress: OutboxProgress, quote: QuoteState, company: QuoteCompany): OutboxStep | null {
  if (company.actCompanyId === null) {
    if (company.heldAt !== null) {
      return { kind: "blocked", reason: companyHeldReason(company.name, company.candidates), by: "company" };
    }
    return company.createChosenAt !== null ? { kind: "create-company" } : { kind: "resolve-company" };
  }
  if (company.ownerPendingUserId !== null) return { kind: "set-owner", record: "company" };
  if (progress.companyWrittenAt === null) return { kind: "write-company" };
  if (!sameId(quote.contactCompanyLinkedFor, company.actCompanyId)) return { kind: "link-contact-company" };
  return null;
}

/** What comes after the contact and before the opportunity step: the contact's owner, then the company. */
function beforeOpportunity(progress: OutboxProgress, quote: QuoteState): OutboxStep | null {
  if (quote.contactOwnerPendingUserId !== null) return { kind: "set-owner", record: "contact" };
  return quote.company ? companyStep(progress, quote, quote.company) : null;
}

/** What comes once the deal has an opportunity: its owner, then its company. */
function afterOpportunity(quote: QuoteState): OutboxStep | null {
  if (quote.actOpportunityId === null) return null;
  if (quote.opportunityOwnerPendingUserId !== null) return { kind: "set-owner", record: "opportunity" };
  const companyId = quote.company?.actCompanyId ?? null;
  if (companyId !== null && !sameId(quote.actOpportunityCompanyId, companyId)) {
    return { kind: "associate-opportunity-company" };
  }
  return null;
}

/**
 * Whether the deal's records still want something from this row -- an
 * owner, the company, its addresses, a link -- which a journaled revision
 * does not finish (A JOURNALED DEAL STILL GETS ITS RECORDS). Never without
 * the contact in ACT!: every one of them comes after it.
 */
function recordsDue(progress: OutboxProgress, quote: QuoteState): boolean {
  if (!quote.contact?.actContactId) return false;
  return beforeOpportunity(progress, quote) !== null || afterOpportunity(quote) !== null;
}
```

`nextStep` — replace its body from `const journaled = revision.actHistoryId !== null;` to the end with:

```typescript
  // A revision already journaled is finished as a revision, whichever row
  // journaled it: nothing that has happened to the quote since reaches back
  // into a write that has gone through. What can still be due is a deal
  // event, the line again for a signature, or the deal's records -- an
  // owner, the company (A JOURNALED DEAL STILL GETS ITS RECORDS) -- each new
  // work rather than that revision's.
  const journaled = revision.actHistoryId !== null;
  const promote = promotionDue(quote);
  const win = winDue(quote);
  const signedLine = signedLineDue(progress, revision, quote);
  const records = recordsDue(progress, quote);
  if (journaled && !promote && !win && !signedLine && !records) return { kind: "done" };

  // Blocking checks, before every step: on a fresh row, before anything is
  // made in ACT!; on a row that has made something already, it keeps it (see
  // the header). The contact first: it is the common case, and the one the
  // reader can fix.
  // No region check: every region has a process (processForRegion's default).
  if (!quote.contact) return { kind: "blocked", reason: NO_CONTACT_REASON };

  if (!quote.contact.actContactId) {
    // A create of this contact may already have made them in ACT! -- for
    // this quote or another on the same contact (A CONTACT CREATE IN
    // FLIGHT). First, because it is the one a second POST makes worse.
    if (quote.contact.actCreateInFlightAt) return { kind: "blocked", reason: UNTRACKED_CONTACT_REASON, by: "contact" };
    // The name only matters when ACT! is about to be asked to create one.
    if (!hasName(quote.contact)) return { kind: "blocked", reason: NAMELESS_CONTACT_REASON };
    return { kind: "create-contact" };
  }

  // The contact's owner, then the company, before anything that needs it
  // (OWNER BY NAME, THE COMPANY).
  const before = beforeOpportunity(progress, quote);
  if (before) return before;

  if (!journaled) {
    if (!progress.opportunityActId) {
      // Set means the deal has an opportunity, open or closed; either way it is
      // updated, never replaced (see ONE OPPORTUNITY PER DEAL above).
      return quote.actOpportunityId ? { kind: "update-opportunity" } : { kind: "create-opportunity" };
    }
    // The opportunity's owner and its company, before its line.
    const after = afterOpportunity(quote);
    if (after) return after;
    // Behind and not skipped by this row. A line productLineWrite left alone
    // is brought up to date by write-accepted-line when the win is due, and
    // asked about again by a later signature's row.
    if (lineBehind(revision, quote) && progress.productLineSkippedAt === null) {
      return { kind: "write-product-line", line: lineWrite(quote) };
    }
    return { kind: "write-history" };
  }

  // Journaled: the opportunity's owner and company first -- an opportunity
  // made before companies were written is associated here.
  const after = afterOpportunity(quote);
  if (after) return after;

  // The deal's money first, the contact's status last (PROMOTION GOES LAST).
  if (win || signedLine) {
    // The row that journaled this revision did its opportunity step first,
    // and nothing clears Document.actOpportunityId, so it is set here unless
    // the database was edited by hand; if it is not, the opportunity is
    // created before its line is written or it is won, rather than either
    // being sent to nothing.
    if (!quote.actOpportunityId) return { kind: "create-opportunity" };
    if (win) {
      // Whatever this row skipped: the win overturns a closed status, and a
      // won deal shows the accepted, signed figure -- written first, as a
      // step of its own.
      return lineBehind(revision, quote)
        ? { kind: "write-accepted-line", line: lineWrite(quote) }
        : { kind: "win-opportunity" };
    }
    // A signature, with the line behind: the line step again.
    return { kind: "write-product-line", line: lineWrite(quote) };
  }

  // Journaled, records settled, and neither the win nor the line due: so the
  // promotion is, or `done` would have been returned above.
  return { kind: "promote-contact" };
```

- [ ] **Step 5: The header contract** — still in `src/lib/act/outbox-plan.ts`:

(a) Replace the step list (lines 16–37, from `//   create-contact` through `//                       GOES LAST)`) with:

```typescript
//   create-contact      only when the quote's contact exists only in PathQuote
//   set-owner contact   the contact just created, given the quote's author as
//                       its owner, by name (OWNER BY NAME)
//   resolve-company     the quote's company has no ACT! company yet: found
//                       through the contact's associated companies or by
//                       name, decided to be created, or held (THE COMPANY)
//   create-company      only when resolve-company found none of its name, or
//                       an administrator chose to create it -- looked up by
//                       name again first (A COMPANY CREATE IN FLIGHT)
//   set-owner company   the company just created, given its owner by name
//   write-company       the company's business and shipping address,
//                       overwritten from PathQuote, once on every row (C3)
//   link-contact-company
//                       the contact associated with the company, when ACT!
//                       associates it with none (C5)
//   create-opportunity  only when the deal has no opportunity yet
//   update-opportunity  instead, when an earlier revision already made one
//   set-owner opportunity
//                       the opportunity just created, given its owner by name
//   associate-opportunity-company
//                       the deal's opportunity associated with the company,
//                       when it is not -- one made before the company was
//                       known included
//   write-product-line  the deal's one product line, which carries its amount:
//                       created the first time, PATCHed in place for a newer
//                       revision, left alone when productLineWrite says so
//                       (see THE PRODUCT LINE)
//   write-history       one History record for this revision
//   write-product-line  again, after the journal, when the client's signature
//                       stands and the line is still behind this revision
//                       (see A WON DEAL SHOWS THE LATEST SIGNED FIGURE)
//   write-accepted-line once the quote is accepted and the client's signature
//                       stands, when the line does not show this revision:
//                       the line is written whatever the deal's status (see
//                       THE LINE IS WRITTEN BEFORE THE WIN)
//   win-opportunity     once the quote is accepted, the client's signature
//                       stands and the line shows this revision: the
//                       opportunity is Won (see THE WIN NEEDS A STANDING
//                       SIGNATURE)
//   promote-contact     once the client's signature stands: the contact goes
//                       from Prospect to Customer. Last of all (see PROMOTION
//                       GOES LAST)
//
// A quote with no company (Document.companyId null) has no company steps,
// and nothing pending is no owner step.
```

(b) In the stored-fields list, after the `Document.actOpportunityWonAt` entry, add:

```typescript
//   Contact.actOwnerPendingUserId, Company.actOwnerPendingUserId,
//   Document.actOpportunityOwnerPendingUserId
//                                set by the create of the record each names,
//                                in the same write as its id; cleared by
//                                set-owner. See OWNER BY NAME.
//   Company.actCompanyId         resolve-company or create-company, or an
//                                administrator's "Use this company". On the
//                                company, so it is decided once for every
//                                quote on it.
//   Company.actCreateChosenAt    resolve-company (ACT! has none of the name)
//                                or an administrator: create-company is due.
//   Company.actCompanyHeldAt,    the drain, holding the company for an
//   Company.actCompanyCandidates administrator: every quote on it that needs
//                                it is blocked "company".
//   ActOutbox.companyWrittenAt   write-company. On the row: every row writes
//                                the addresses once (C3); a take-over clears
//                                it.
//   Contact.actCompanyLinkedFor  link-contact-company: the ACT! company it
//                                settled the contact for.
//   Document.actOpportunityCompanyId
//                                associate-opportunity-company.
```

and change the paragraph "Of these, Contact.actContactId dates from z60_act_sync; …" by appending: " Every column of the list above added since -- the owners, the company's and the link's -- was added by z71_act_write_back_companies, which also has a take-over clear ActOutbox.companyWrittenAt."

(c) Insert these sections before `// ONE HISTORY PER REVISION`:

```typescript
// OWNER BY NAME (decision O1, 2026-10-16). ACT! ignores recordManagerID on a
// create: everything PathQuote made came back owned by the login. It takes
// a PATCH of `recordManager`, the user's name, on a contact, a company and an
// opportunity -- an Inactive user's included -- and never on a History
// (src/lib/act/record-owner.ts has the probe's findings). So each of those
// three creates stores, IN THE SAME WRITE AS THE RECORD'S ID, the ACT! user
// it is to be owned by: the row's author's User.actUserId, or nothing when
// the author has none, and the login keeps it. set-owner is planned while
// that is stored: the drain reads the record, PATCHes the name only when the
// record does not already read so (ownerPatch), and clears it.
//
// A STEP, NOT THE TAIL OF THE CREATE. A create's id is stored the moment ACT!
// answers (STEPS RESUME, below), and the planner never plans a create again.
// An owner PATCH made after that store inside the create step, failing,
// would be lost: the create is done. As a step of its own it resumes like any
// other, decides on a fresh read, and fails like any PATCH -- backed off
// when ACT! does not answer, held ("act") when it refuses. Two answers clear
// it without a PATCH or a hold: the user is no longer among ACT!'s, and ACT!
// answered but kept the owner; the drain logs both. A record created before
// owners were set by name, or found rather than made, has nothing stored and
// is never re-owned.
//
// THE COMPANY (decisions C1-C5). Every contact PathQuote sends ends up
// associated with a real ACT! Company carrying PathQuote's addresses. In
// order, after the contact and its owner:
//
//   resolve-company   Company.actCompanyId null and the company not held:
//                     the drain reads the contact's associated companies,
//                     then ACT!'s companies by name (fromAssociations,
//                     fromNameLookup in src/lib/act/company-resolve.ts). One
//                     found: stored as Company.actCompanyId. None of the
//                     name: Company.actCreateChosenAt. Several it cannot
//                     tell apart, or one another PathQuote company already
//                     carries: held (Company.actCompanyHeldAt and the
//                     candidates), and every quote on the company is blocked
//                     "company" -- by nextStep, from the hold -- until an
//                     administrator chooses ("Use this company", or "Create a
//                     new company in ACT!", which sets actCreateChosenAt and
//                     keeps the candidates as those seen).
//   create-company    actCreateChosenAt set: see A COMPANY CREATE IN FLIGHT.
//   set-owner company the company PathQuote made.
//   write-company     both addresses, overwritten from PathQuote on every row
//                     (companyAddressPatch in src/lib/act/write-payloads.ts);
//                     the row's companyWrittenAt says this row has.
//   link-contact-company
//                     the contact associated with the company when ACT!
//                     associates it with none (C5); Contact.actCompanyLinkedFor
//                     says which company that was settled for.
//
// and, once the deal has an opportunity, associate-opportunity-company
// (Document.actOpportunityCompanyId). The opportunity and the History carry
// the company in their bodies when it is known (companiesOf in
// src/lib/act/write-payloads.ts), which the company steps make sure it is.
// All of it is on the Company -- the PathQuote client, shared by every quote
// on it -- so it is decided once a company, not once a quote.
//
// A COMPANY CREATE IN FLIGHT. Company.actCreateInFlightAt is set before the
// POST and cleared as a contact's marker is (A CREATE IN FLIGHT). Unlike a
// contact, a company has an identity ACT! can be asked about -- its name --
// so the marker does not block on its own: create-company looks the name up
// before EVERY POST (beforeCompanyCreate), and a company of that name it has
// not already seen is used when it is the only one (in the company's
// country) -- and owned too, with the marker standing, since that is the one
// the lost POST made -- or held for an administrator. No POST goes out while
// a company of the name nobody has looked at is in ACT!, and every quote on
// the company is held for as long as that lookup cannot settle it, which is
// the hold a contact's marker gives.
//
// A JOURNALED DEAL STILL GETS ITS RECORDS. The owners, the company, its
// addresses, the link and the opportunity's company are the deal's, not the
// revision's, so a row whose revision is journaled is `done` only once none
// of them is due either. That is how a deal journaled before companies were
// written -- Danam's, the first live quote -- gets its company and its
// opportunity's at its next event. They need the contact in ACT!: a
// journaled row whose contact is gone, or not in ACT!, is `done` as before.
//
```

(d) In ONE HISTORY PER REVISION, change "it is done, unless a deal event is still due." to "it is done, unless a deal event, or one of the deal's records (A JOURNALED DEAL STILL GETS ITS RECORDS), is still due."

(e) In THE BLOCKER, after the `"contact"` entry, add:

```typescript
//   "company"   the quote held for its company (Company.actCompanyHeldAt):
//               several ACT! companies could be it, or the one found is
//               another PathQuote client's. Set by the drain (resolve-company,
//               create-company); nextStep then blocks with `by: "company"`
//               for as long as the hold stands. Re-planned like "contact", and
//               lifted once an administrator has chosen
//               (src/lib/act/outbox-admin.ts).
```

- [ ] **Step 6: The drain's rules** — in `src/lib/act/drain-rules.ts`:

`stepAction`: add before `case "create-opportunity":`

```typescript
    case "set-owner":
      return "make this quote's author the owner of its new record in ACT!";
    case "resolve-company":
      return "find this quote's company in ACT!";
    case "create-company":
      return "create this quote's company in ACT!";
    case "write-company":
      return "write this quote's company's addresses into ACT!";
    case "link-contact-company":
      return "link this quote's contact to its company in ACT!";
    case "associate-opportunity-company":
      return "link this quote's opportunity to its company in ACT!";
```

`BLOCKED_BY`: add `company: "company",` after `contact`, and in its comment after the `contact` entry:

```typescript
 *   company   held for its company: several ACT! companies could be the
 *             quote's company, or the one found is another PathQuote
 *             client's (THE COMPANY in src/lib/act/outbox-plan.ts). Set by
 *             the drain's company steps; the planner blocks with `by:
 *             "company"` while Company.actCompanyHeldAt stands. Re-planned
 *             like `contact`, lifted once an administrator has chosen.
```

`plannerBlockedBy`:

```typescript
export function plannerBlockedBy(
  step: Extract<OutboxStep, { kind: "blocked" }>,
): typeof BLOCKED_BY.contact | typeof BLOCKED_BY.company | null {
  if (step.by === BLOCKED_BY.contact) return BLOCKED_BY.contact;
  if (step.by === BLOCKED_BY.company) return BLOCKED_BY.company;
  return null;
}
```

`Replan`'s reblock: `by: typeof BLOCKED_BY.contact | typeof BLOCKED_BY.company | null`. `REPLANNED`: `new Set([null, BLOCKED_BY.contact, BLOCKED_BY.company, BLOCKED_BY.drain])`.

- [ ] **Step 7: The drain: the planner's new inputs, and the owner step** — in `src/lib/act/drain.ts`:

Imports: add `OWNER_COLLECTION, actUserName, ownerPatch, ownerTaken, type OwnerRecord` from `@/lib/act/record-owner`; add `ActUser` to the `@/lib/act/types` type import.

`ROW_SELECT`: add `companyWrittenAt: true,` after `createInFlight: true,`; in `document.select` add `actOpportunityOwnerPendingUserId: true, actOpportunityCompanyId: true,` after `actOpportunityWonAt: true,`; replace `company: { select: { actCompanyId: true } },` with

```typescript
      company: {
        select: {
          id: true,
          name: true,
          street: true,
          city: true,
          state: true,
          postcode: true,
          country: true,
          deliverySameAsMain: true,
          deliveryStreet: true,
          deliveryCity: true,
          deliveryState: true,
          deliveryPostcode: true,
          deliveryCountry: true,
          actCompanyId: true,
          actCompanyHeldAt: true,
          actCompanyCandidates: true,
          actCreateChosenAt: true,
          actCreateInFlightAt: true,
          actOwnerPendingUserId: true,
        },
      },
```

and in the contact select add `actOwnerPendingUserId: true, actCompanyLinkedFor: true,` after `actCreateInFlightAt: true,`.

`quoteStateOf`: add after `actOpportunityWonAt: doc.actOpportunityWonAt,`

```typescript
    contactOwnerPendingUserId: doc.contact?.actOwnerPendingUserId ?? null,
    contactCompanyLinkedFor: doc.contact?.actCompanyLinkedFor ?? null,
    // Handed to the planner from Task 10 of docs/superpowers/plans/2026-10-16-act-write-back-companies.md,
    // with the company steps that act on it: until then no company step is
    // planned, so nothing is held before an administrator can settle it.
    company: null,
    opportunityOwnerPendingUserId: doc.actOpportunityOwnerPendingUserId,
    actOpportunityCompanyId: doc.actOpportunityCompanyId,
```

`plan`: the progress object gains `companyWrittenAt: row.companyWrittenAt,`.

`BlockRow`'s `by` type: `typeof BLOCKED_BY.contact | typeof BLOCKED_BY.company | typeof BLOCKED_BY.drain | typeof BLOCKED_BY.revision`.

`Pass`: add the field `private actUsers: ActUser[] | null = null;` and replace `serviceAccount` with the users cache and the two readers of it:

```typescript
  /**
   * ACT!'s users, read once a pass: the service account's id and every
   * owner's name come from them. A pass that cannot read them stops. So
   * does a lookup that FAILS, however it fails: it is not cached on failure,
   * so going on would ask again for every row that needs it -- each time
   * waiting out the same timeouts, or meeting the same answer. A 403 to it is
   * the service account's own access, not any one record's. The row being
   * worked backs off for the failure (StopPass's `failed`); the rest are left
   * for the next pass.
   */
  private async users(): Promise<ActUser[]> {
    if (this.actUsers) return this.actUsers;
    await this.beforeCall();
    try {
      this.actUsers = await this.client.users();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StopPass(
        "stopped",
        error instanceof ActApiError && error.status === 403
          ? `ACT! answered 403 to the users lookup, so PathQuote's login "${this.client.loginName}" (ACT_USER) is not allowed to read ACT!'s users — check its licence and permissions`
          : `the lookup of ACT!'s users failed, and the service account cannot be known without it: ${message}`,
        stopCause(drainFailure(error)),
        error,
      );
    }
    return this.actUsers;
  }

  /** The service account's ACT! user id, from users(); a pass that cannot find it stops. */
  private async serviceAccount(): Promise<string> {
    if (this.serviceAccountId) return this.serviceAccountId;
    const id = serviceAccountUserId(await this.users(), this.client.loginName);
    if (!id) {
      throw new StopPass(
        "stopped",
        `no ACT! user, or more than one, has the login "${this.client.loginName}" (ACT_USER), so there is no record manager for a quote whose author has no ACT! user — check ACT_USER against ACT!'s users`,
        "setup",
      );
    }
    this.serviceAccountId = id;
    return id;
  }
```

`execute`: add before `case "create-opportunity":`

```typescript
      case "set-owner":
        return this.setOwner(row, step.record);
      case "resolve-company":
      case "create-company":
      case "write-company":
      case "link-contact-company":
      case "associate-opportunity-company":
        // Planned only for a quote with a company, and quoteStateOf hands the
        // planner none until the company steps are wired (Task 10 of the plan).
        throw new Error(`the planner planned ${step.kind}, but the drain hands it no company yet`);
```

The pending owner, stored with each create's id. In `createContact`, both calls of `this.storeCreated(row, contact.id, <id>, <record>)` gain a last argument `row.document.author.actUserId`; `storeCreated` and `storeContactCreated` gain the parameter `ownerUserId: string | null` (passed through), and `storeContactCreated`'s `db.contact.update` data gains `actOwnerPendingUserId: ownerUserId,`. In `createOpportunity`'s adopt branch and in `storeOpportunityCreated`, the `db.document.update` data becomes `{ actOpportunityId: <id>, ...this.opportunityOwner(row) }`, with:

```typescript
  /** The opportunity's pending owner, stored with its id: the author's ACT! user, or nothing. See OWNER BY NAME. */
  private opportunityOwner(row: Row): { actOpportunityOwnerPendingUserId?: string } {
    const author = row.document.author.actUserId;
    return author ? { actOpportunityOwnerPendingUserId: author } : {};
  }
```

The step, after `promoteContact`:

```typescript
  /**
   * set-owner (OWNER BY NAME in src/lib/act/outbox-plan.ts): the record
   * PathQuote created given the ACT! user stored as pending for it, by name
   * -- read, PATCHed only when it does not already read so, read again
   * (ActClient.setRecordManager) -- and the pending owner cleared, guarded on
   * the value read. A user ACT! no longer lists, and an answer that kept the
   * owner, clear it too, logged: the login keeps the record. For a contact,
   * a PATCH that went out moves its `edited`, so the record read back after
   * it is stored as its ActSnapshot and its `edited` as actSourceEditedAt:
   * the baseline storeContactCreated describes, which the next inbound sync
   * compares (changedInAct in src/lib/act/merge.ts) and does not count as an
   * edit.
   */
  private async setOwner(row: Row, record: OwnerRecord): Promise<StepOutcome> {
    const target = this.ownerTarget(row, record);
    const name = actUserName(await this.users(), target.pendingUserId);
    if (name === null) {
      console.warn("act: the ACT! user a record was to be owned by is not among ACT!'s users; the login keeps it", {
        id: row.id,
        record,
        actUserId: target.pendingUserId,
      });
      await target.clear(null);
      return "stored";
    }
    await this.beforeCall();
    const updated = await this.client.setRecordManager(OWNER_COLLECTION[record], target.actId, (current) =>
      ownerPatch(current.recordManager, name),
    );
    if (!ownerTaken(updated.record.recordManager, name)) {
      console.warn("act: ACT! answered the owner PATCH and kept the record's owner; the login keeps it", {
        id: row.id,
        record,
        name,
        recordManager: updated.record.recordManager,
      });
    }
    await target.clear(updated.written ? updated.record : null);
    return "stored";
  }

  /** The record set-owner works on: its ACT! id, the pending owner, and how to clear it. */
  private ownerTarget(
    row: Row,
    record: OwnerRecord,
  ): { actId: string; pendingUserId: string; clear: (written: Record<string, unknown> | null) => Promise<unknown> } {
    switch (record) {
      case "contact": {
        const contact = row.document.contact;
        const pending = contact?.actOwnerPendingUserId;
        if (!contact || !pending) throw new Error("the planner planned set-owner for a contact with no owner pending");
        return {
          actId: this.contactActId(row),
          pendingUserId: pending,
          clear: (written) => {
            const edited = written ? editedAt(written) : null;
            const payload = written as unknown as Prisma.InputJsonValue;
            return db.$transaction([
              db.contact.updateMany({
                where: { id: contact.id, actOwnerPendingUserId: pending },
                data: {
                  actOwnerPendingUserId: null,
                  ...(written ? { actSyncedAt: new Date(), ...(edited ? { actSourceEditedAt: edited } : {}) } : {}),
                },
              }),
              ...(written
                ? [db.actSnapshot.upsert({ where: { contactId: contact.id }, create: { contactId: contact.id, payload }, update: { payload } })]
                : []),
            ]);
          },
        };
      }
      case "company": {
        const company = row.document.company;
        const pending = company?.actOwnerPendingUserId;
        if (!company?.actCompanyId || !pending) throw new Error("the planner planned set-owner for a company with no owner pending");
        return {
          actId: company.actCompanyId,
          pendingUserId: pending,
          // No snapshot: the inbound sync reads contacts only, never a company.
          clear: () =>
            db.company.updateMany({ where: { id: company.id, actOwnerPendingUserId: pending }, data: { actOwnerPendingUserId: null } }),
        };
      }
      case "opportunity": {
        const pending = row.document.actOpportunityOwnerPendingUserId;
        if (!pending) throw new Error("the planner planned set-owner for an opportunity with no owner pending");
        return {
          actId: this.opportunityId(row),
          pendingUserId: pending,
          clear: () =>
            db.document.updateMany({
              where: { id: row.document.id, actOpportunityOwnerPendingUserId: pending },
              data: { actOpportunityOwnerPendingUserId: null },
            }),
        };
      }
    }
  }
```

In `src/lib/act/merge.ts`'s `changedInAct` comment, change "The drain stores the `edited` ACT! answers a contact create or promotion with (storeContactCreated and promoteContact in src/lib/act/drain.ts)" to "The drain stores the `edited` ACT! answers a contact create, a promotion, an owner set by name or a company link with (storeContactCreated, promoteContact, setOwner and linkContactCompany in src/lib/act/drain.ts)".

- [ ] **Step 8: Verify**

Run: `npx vitest run tests/act-outbox-plan.test.ts tests/act-drain-rules.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test && npm run build`
Expected: PASS (16 new planner tests, 3 new rules tests, every existing one unchanged); `14`; clean; all pass; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/lib/act/outbox-plan.ts src/lib/act/drain-rules.ts src/lib/act/drain.ts src/lib/act/merge.ts tests/act-outbox-plan.test.ts tests/act-drain-rules.test.ts
git commit -m "act: the planner's company and owner steps, and every new record owned by its author

Six steps join the sequence, in the spec's order: the contact's owner, the
company found or created, its owner, its addresses, the contact's link, then
the opportunity, its owner and its company. The owner is a step of its own,
driven by a pending owner stored in the same write as the new record's id:
an owner PATCH inside the create step that failed after the id was stored
would be lost, and the planner never plans a create twice.

A journaled revision is done only once the deal's records are settled too,
so a deal journaled before companies existed gets its company at its next
event. A company held for an administrator holds every quote on it,
blockedBy company.

The drain sets owners from now on; it hands the planner no company until
the company steps are wired, so nothing is held before an administrator
can settle it."
```

---

### Task 8: What an administrator may do about a held company

**Files:** modify `src/lib/act/outbox-admin.ts`, `tests/act-outbox-admin.test.ts`

- [ ] **Step 1: Write the failing test** — in `tests/act-outbox-admin.test.ts`, add to the imports from `../src/lib/act/outbox-admin`: `COMPANY_NOT_HELD_ERROR, NOT_A_CANDIDATE_ERROR, companyCreateDecision, companyTakenError, companyUseDecision, heldForCompany, heldForCompanyRelease, type AdminCompany`, and `import type { CompanyCandidate } from "../src/lib/act/company-resolve";`. Update the two existing `toEqual`s of `adminActionsFor` — the `none` object and the "only Don't send" expectation — with `companyUse: false, companyCreate: false`. Then append:

```typescript
const COMPANY_HELD_AT = new Date("2026-10-16T03:00:00.000Z");
const SUVA: CompanyCandidate = { id: "c0000000-0000-4000-8000-0000000000e1", name: "Danam Fiji", city: "Suva", country: "Fiji", takenBy: null };
const LAUTOKA: CompanyCandidate = { ...SUVA, id: "c0000000-0000-4000-8000-0000000000e2", city: "Lautoka" };

function heldCompany(overrides: Partial<AdminCompany> = {}): AdminCompany {
  return { id: "company1", actCompanyId: null, actCompanyHeldAt: COMPANY_HELD_AT, candidates: [SUVA, LAUTOKA], ...overrides };
}
const companyRow = row({ blockedReason: "ACT! has 2 companies that could be ...", blockedBy: BLOCKED_BY.company });

describe("heldForCompany", () => {
  it("is a row held for its company whose company is still held, with no ACT! id", () => {
    expect(heldForCompany(companyRow, heldCompany())).toBe(true);
    expect(heldForCompany(companyRow, heldCompany({ actCompanyId: SUVA.id }))).toBe(false);
    expect(heldForCompany(companyRow, heldCompany({ actCompanyHeldAt: null }))).toBe(false);
    expect(heldForCompany(row({ blockedReason: "x", blockedBy: BLOCKED_BY.act }), heldCompany())).toBe(false);
    expect(heldForCompany(row({ ...companyRow, completedAt: NOW }), heldCompany())).toBe(false);
    expect(heldForCompany(companyRow, null)).toBe(false);
  });
});

describe("adminActionsFor: a quote held for its company", () => {
  it("offers both company actions and Don't send, and nothing for the contact", () => {
    expect(adminActionsFor(companyRow, null, heldCompany())).toEqual({
      tryAgain: false,
      contactFound: false,
      contactAbsent: false,
      companyUse: true,
      companyCreate: true,
      dontSend: true,
    });
  });

  it("offers no 'Use this company' when the only candidate is another client's", () => {
    const taken = heldCompany({ candidates: [{ ...SUVA, takenBy: "Danam Fiji" }] });
    expect(adminActionsFor(companyRow, null, taken)).toMatchObject({ companyUse: false, companyCreate: true });
  });
});

describe("companyUseDecision: 'Use this company'", () => {
  it("stores the chosen candidate's id, ends the hold and the create, guarded on the hold read", () => {
    expect(companyUseDecision({ row: companyRow, company: heldCompany(), actCompanyId: LAUTOKA.id.toUpperCase(), takenBy: null })).toEqual({
      ok: true,
      write: {
        where: { id: "company1", actCompanyId: null, actCompanyHeldAt: COMPANY_HELD_AT },
        data: { actCompanyId: LAUTOKA.id, actCompanyHeldAt: null, actCreateChosenAt: null, actCreateInFlightAt: null },
        clearCandidates: true,
      },
    });
  });

  it("refuses an id that is not one of the candidates PathQuote listed", () => {
    expect(companyUseDecision({ row: companyRow, company: heldCompany(), actCompanyId: "c0000000-0000-4000-8000-0000000000ff", takenBy: null })).toEqual({
      ok: false,
      error: NOT_A_CANDIDATE_ERROR,
    });
  });

  it("refuses a company another PathQuote client carries, naming it", () => {
    expect(companyUseDecision({ row: companyRow, company: heldCompany(), actCompanyId: SUVA.id, takenBy: "Danam Fiji Ltd" })).toEqual({
      ok: false,
      error: companyTakenError("Danam Fiji", "Danam Fiji Ltd"),
    });
  });

  it("refuses a quote whose company is not held any more, or that has no row", () => {
    expect(companyUseDecision({ row: companyRow, company: heldCompany({ actCompanyHeldAt: null }), actCompanyId: SUVA.id, takenBy: null })).toEqual({
      ok: false,
      error: COMPANY_NOT_HELD_ERROR,
    });
    expect(companyUseDecision({ row: null, company: heldCompany(), actCompanyId: SUVA.id, takenBy: null })).toEqual({
      ok: false,
      error: NO_ROW_ERROR,
    });
  });
});

describe("companyCreateDecision: 'Create a new company in ACT!'", () => {
  it("decides the create and ends the hold, KEEPING the candidates as the companies seen", () => {
    expect(companyCreateDecision(companyRow, heldCompany(), NOW)).toEqual({
      ok: true,
      write: {
        where: { id: "company1", actCompanyId: null, actCompanyHeldAt: COMPANY_HELD_AT },
        data: { actCompanyHeldAt: null, actCreateChosenAt: NOW, actCreateInFlightAt: null },
        clearCandidates: false,
      },
    });
  });

  it("refuses a company that is not held", () => {
    expect(companyCreateDecision(companyRow, heldCompany({ actCompanyId: SUVA.id }), NOW)).toEqual({ ok: false, error: COMPANY_NOT_HELD_ERROR });
  });
});

describe("heldForCompanyRelease", () => {
  it("makes due every row held for the company, guarded each with its own generation, and leaves the rest", () => {
    const rows = [
      row({ id: "a", generation: 2, blockedReason: "held", blockedBy: BLOCKED_BY.company }),
      row({ id: "b", generation: 0, blockedReason: "refused", blockedBy: BLOCKED_BY.act }),
    ];
    expect(heldForCompanyRelease(rows, NOW)).toEqual([
      {
        where: { id: "a", generation: 2, completedAt: null },
        data: { blockedReason: null, blockedBy: null, nextAttemptAt: NOW, generation: 3 },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-outbox-admin.test.ts`
Expected: FAIL — `heldForCompany is not a function` …; the two updated `adminActionsFor` cases fail on the missing keys.

- [ ] **Step 3: Implement** — in `src/lib/act/outbox-admin.ts`:

In the header's list of actions, after "ACT! has nobody":

```typescript
//   Use this company       a quote held for its company: one of the ACT!
//                          companies the drain listed is chosen
//                          (companyUseDecision)
//   Create a new company   the same quote, the other answer
//     in ACT!              (companyCreateDecision)
```

and after the paragraph "The Contact's writes are guarded on its own state instead…", add:

```typescript
// So are the Company's: on the hold read (Company.actCompanyHeldAt) and no
// ACT! company yet. A company's candidates came from ACT! when the drain
// held it, so choosing one needs no call into ACT!: the id must be one of
// them, and no other PathQuote company may carry it.
```

Imports: add `import type { CompanyCandidate } from "@/lib/act/company-resolve";` and `import { sameRecordId, tryLaterStatus } from "@/lib/act/record-write";` (replacing the `tryLaterStatus`-only import).

After `ContactWrite`:

```typescript
/** The quote's company, as an action reads it. */
export type AdminCompany = {
  id: string;
  actCompanyId: string | null;
  actCompanyHeldAt: Date | null;
  /** Company.actCompanyCandidates, read (readCandidates in src/lib/act/company-resolve.ts). */
  candidates: readonly CompanyCandidate[];
};

/**
 * A write to the Company, guarded on the hold still being as read.
 * `clearCandidates` also sets Company.actCompanyCandidates to SQL NULL --
 * Prisma.DbNull, which this module does not import (see the header), so the
 * store adds it.
 */
export type CompanyWrite = {
  where: Prisma.CompanyWhereInput & { id: string };
  data: Prisma.CompanyUpdateManyMutationInput;
  clearCandidates: boolean;
};
```

After `heldForContact`:

```typescript
/**
 * Whether the quote is held for its company: its row unfinished and held for
 * its company (blockedBy BLOCKED_BY.company), and the company still held --
 * no ACT! company, and the hold the drain set. Read off blockedBy, as
 * heldForContact is.
 */
export function heldForCompany(
  row: Pick<AdminRow, "completedAt" | "blockedBy"> | null,
  company: Pick<AdminCompany, "actCompanyId" | "actCompanyHeldAt"> | null,
): boolean {
  return (
    row !== null &&
    row.completedAt === null &&
    row.blockedBy === BLOCKED_BY.company &&
    company !== null &&
    company.actCompanyId === null &&
    company.actCompanyHeldAt !== null
  );
}
```

`AdminActions` gains `companyUse: boolean; companyCreate: boolean;` and `adminActionsFor` becomes:

```typescript
export function adminActionsFor(row: AdminRow | null, contact: AdminContact | null, company: AdminCompany | null = null): AdminActions {
  const unfinished = row !== null && row.completedAt === null;
  const held = heldForContact(row, contact);
  const companyHeld = heldForCompany(row, company);
  return {
    tryAgain: unfinished && row.blockedReason !== null && row.blockedBy !== null && RETRYABLE.has(row.blockedBy),
    contactFound: held,
    contactAbsent: held,
    companyUse: companyHeld && company !== null && company.candidates.some((candidate) => candidate.takenBy === null),
    companyCreate: companyHeld,
    dontSend: unfinished,
  };
}
```

At the end of the file:

```typescript
/** Shown when the company is not held any more, or not as it was read. */
export const COMPANY_NOT_HELD_ERROR =
  "This quote's company is not held as it was any more — it has its ACT! company, or somebody chose already. Reload the page to see where the quote stands now.";

/** Shown for an id the drain did not list for this company. */
export const NOT_A_CANDIDATE_ERROR =
  "That company is not one of those PathQuote listed for this quote, so nothing was linked. Reload the page and choose from the list again.";

/** The refusal for a company another PathQuote client already carries (Company.actCompanyId is unique). */
export function companyTakenError(actName: string, takenBy: string): string {
  return `ACT!'s company "${actName}" is already PathQuote's client "${takenBy}", and PathQuote cannot give one ACT! company to two clients — ask your developer to merge the two clients, or create a new company in ACT! for this one.`;
}

/**
 * "Use this company": the held company is given the ACT! company an
 * administrator chose from the candidates the drain listed -- its id as
 * listed, whatever case it was sent back in. The hold, a decision to create
 * and a create in flight all end with it, and the candidates are cleared.
 * Guarded on the hold read and on no ACT! company yet. `takenBy` is another
 * PathQuote company carrying that id, which the caller looks up; present, or
 * recorded on the candidate by the drain, it refuses. No owner is set: the
 * company is ACT!'s own.
 */
export function companyUseDecision(input: {
  row: AdminRow | null;
  company: AdminCompany | null;
  actCompanyId: string;
  takenBy: string | null;
}): Decision<CompanyWrite> {
  if (!input.row) return { ok: false, error: NO_ROW_ERROR };
  const company = input.company;
  if (!company || !heldForCompany(input.row, company)) return { ok: false, error: COMPANY_NOT_HELD_ERROR };
  const candidate = company.candidates.find((c) => sameRecordId(c.id, input.actCompanyId.trim()));
  if (!candidate) return { ok: false, error: NOT_A_CANDIDATE_ERROR };
  const takenBy = input.takenBy ?? candidate.takenBy;
  if (takenBy) return { ok: false, error: companyTakenError(candidate.name, takenBy) };
  return {
    ok: true,
    write: {
      where: { id: company.id, actCompanyId: null, actCompanyHeldAt: company.actCompanyHeldAt },
      data: { actCompanyId: candidate.id, actCompanyHeldAt: null, actCreateChosenAt: null, actCreateInFlightAt: null },
      clearCandidates: true,
    },
  };
}

/**
 * "Create a new company in ACT!": the hold ends, create-company is due
 * (actCreateChosenAt), and a create in flight is released -- the
 * administrator has looked at what ACT! holds, as "ACT! has nobody" says of
 * a contact. The candidates are KEPT: they are the companies seen and passed
 * over, and create-company POSTs only when ACT! holds no other company of
 * the name (beforeCompanyCreate in src/lib/act/company-resolve.ts). If one
 * of them was the company after all, this puts it in ACT! twice; the
 * button's confirmation says so.
 */
export function companyCreateDecision(row: AdminRow | null, company: AdminCompany | null, now: Date): Decision<CompanyWrite> {
  if (!row) return { ok: false, error: NO_ROW_ERROR };
  if (!company || !heldForCompany(row, company)) return { ok: false, error: COMPANY_NOT_HELD_ERROR };
  return {
    ok: true,
    write: {
      where: { id: company.id, actCompanyId: null, actCompanyHeldAt: company.actCompanyHeldAt },
      data: { actCompanyHeldAt: null, actCreateChosenAt: now, actCreateInFlightAt: null },
      clearCandidates: false,
    },
  };
}

/**
 * After either company action: every quote on the company still held for it
 * is made due now, as heldForContactRelease does for a contact, and for the
 * same reason -- not needed for correctness (the drain's pass re-plans and
 * lifts them), but the quotes stop saying they are held the moment it is
 * settled.
 */
export function heldForCompanyRelease(rows: readonly AdminRow[], now: Date): RowWrite[] {
  return rows
    .filter((row) => row.completedAt === null && row.blockedBy === BLOCKED_BY.company)
    .map((row) => guarded(row, { blockedReason: null, blockedBy: null, nextAttemptAt: now }));
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-outbox-admin.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npx eslint src/lib/act/outbox-admin.ts tests/act-outbox-admin.test.ts`
Expected: PASS (10 new tests, every existing one with its two updated expectations); `14`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/outbox-admin.ts tests/act-outbox-admin.test.ts
git commit -m "act: an administrator settles a held company -- use one of ACT!'s, or create a new one

The candidates came from ACT! when the drain held the company, so choosing
one asks ACT! nothing: the id must be one listed, and no other PathQuote
client may carry it. 'Create a new company' keeps the candidates as the
companies seen, so the create still looks for any other company of the name
first. Both are guarded on the hold read, and release every quote held for
the company."
```

---

### Task 9: The held company on the quote's ACT! card

**Files:** modify `src/lib/act/outbox-admin-store.ts`, `src/lib/actions/act-outbox.ts`, `src/lib/act/quote-act-view.ts`, `src/lib/queries/act-quote.ts`, `src/components/documents/act-state-card.tsx`, `src/components/documents/act-admin-actions.tsx`, `tests/act-quote-view.test.ts`

- [ ] **Step 1: Write the failing test** — in `tests/act-quote-view.test.ts`: in the `facts` helper add `company: null,` after `line: null,`; import `BLOCKED_BY` (already) and `import type { CompanyCandidate } from "../src/lib/act/company-resolve";` and `import { companyHeldReason } from "../src/lib/act/company-resolve";`; append:

```typescript
describe("a quote held for its company", () => {
  const SUVA: CompanyCandidate = { id: "c0000000-0000-4000-8000-0000000000e1", name: "Danam Fiji", city: "Suva", country: "Fiji", takenBy: null };
  const TAKEN: CompanyCandidate = { ...SUVA, id: "c0000000-0000-4000-8000-0000000000e2", city: "Lautoka", takenBy: "Danam Fiji Ltd" };
  const HELD_AT = new Date("2026-10-16T03:00:00.000Z");
  const reason = companyHeldReason("Danam (Fiji) Pte Limited", [SUVA, TAKEN]);
  const heldFacts = facts({
    company: { name: "Danam (Fiji) Pte Limited", actCompanyId: null, actCompanyHeldAt: HELD_AT, candidates: [SUVA, TAKEN] },
    row: row({ blockedReason: reason, blockedBy: BLOCKED_BY.company }),
  });

  it("shows a manager the hold and its sentence, which names the candidates", () => {
    const view = describeQuoteAct(heldFacts, NOW, MANAGER);
    expect(view?.state).toBe("held");
    expect(view?.detail).toBe(reason);
  });

  it("tells an administrator what the list below is", () => {
    expect(asAdmin(heldFacts, NOW)?.adminNote).toBe(
      "PathQuote listed the companies below from ACT! when it held this quote, at 16 Oct 2026, 2:00 pm Melbourne time. Look at them in ACT!, then use the one Danam (Fiji) Pte Limited is, or create a new one if none is.",
    );
  });

  it("words the company buttons, a candidate another client carries marked and not choosable", () => {
    const help = adminHelpFor({ ...QUOTE, blockedBy: BLOCKED_BY.company, contactName: null, number: "Q-AU-2026-002", companyName: "Danam (Fiji) Pte Limited", candidates: [SUVA, TAKEN] });
    expect(help.companyUse.choices).toEqual([
      { id: SUVA.id, line: "Danam Fiji, Suva, Fiji", taken: false },
      { id: TAKEN.id, line: 'Danam Fiji, Lautoka, Fiji — already PathQuote\'s client "Danam Fiji Ltd"', taken: true },
    ]);
    expect(help.companyCreate.confirm.title).toBe("Create Danam (Fiji) Pte Limited in ACT!?");
  });

  it("names the company among what ACT! holds, once the quote is in ACT!", () => {
    const done = facts({
      company: { name: "Danam (Fiji) Pte Limited", actCompanyId: SUVA.id, actCompanyHeldAt: null, candidates: [] },
      row: row({ completedAt: NOW }),
    });
    expect(asAdmin(done, NOW)?.facts).toContainEqual({ label: "Company", value: "Danam (Fiji) Pte Limited" });
  });
});
```

The time is `melbourneTime(HELD_AT)` (`src/lib/act/sync-view.ts`): 03:00 UTC on 16 Oct 2026 is 2:00 pm AEDT, printed in the shape the contact hold's existing test expects ("13 Oct 2026, 10:05 am Melbourne time").

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-quote-view.test.ts`
Expected: FAIL — no `adminNote`, `help.companyUse` undefined, no "Company" fact.

- [ ] **Step 3: The view** — in `src/lib/act/quote-act-view.ts`:

Imports: `import { heldForCompany, heldForContact } from "@/lib/act/outbox-admin";` and `import { candidateLine, type CompanyCandidate } from "@/lib/act/company-resolve";`.

`QuoteActFacts` gains, after `line`:

```typescript
  /**
   * The quote's company, as the card reads it, or null for none: its ACT!
   * company once found, and, while it is held for an administrator, when and
   * with which candidates (Company.actCompanyHeldAt, actCompanyCandidates).
   */
  company: {
    name: string;
    actCompanyId: string | null;
    actCompanyHeldAt: Date | null;
    candidates: readonly CompanyCandidate[];
  } | null;
```

In `held`, replace the `adminNote:` expression with:

```typescript
    adminNote:
      contactHeld && contact?.actCreateInFlightAt
        ? `Look in ACT! for ${contact.name}. If PathQuote's request reached ACT!, they were created there at about ${melbourneTime(contact.actCreateInFlightAt)}. Then choose one of the two below.`
        : companyHeld && facts.company?.actCompanyHeldAt
          ? facts.company.candidates.length > 0
            ? `PathQuote listed the companies below from ACT! when it held this quote, at ${melbourneTime(facts.company.actCompanyHeldAt)}. Look at them in ACT!, then use the one ${facts.company.name} is, or create a new one if none is.`
            : `PathQuote could not look ${facts.company.name} up in ACT! by its name. Look for it in ACT! by hand: if it is there, your developer can link it; if not, create it below.`
          : null,
```

with `const companyHeld = heldForCompany(row, facts.company);` beside `contactHeld`, and add to the function's comment: "The other is for a company held for an administrator: what the listed candidates are, given exactly when the two company actions are offered (heldForCompany)."

In `inAct`, after the Contact fact:

```typescript
  if (facts.company?.actCompanyId) out.push({ label: "Company", value: facts.company.name });
```

(and a line in its comment: `Company      the quote's company, once it has its ACT! company.`)

`AdminHelp` gains:

```typescript
  companyUse: { label: string; help: string; choices: { id: string; line: string; taken: boolean }[] };
  companyCreate: { label: string; help: string; confirm: ConfirmWords };
```

`adminHelpFor`'s input gains `companyName?: string | null; candidates?: readonly CompanyCandidate[];`, and its result:

```typescript
    companyUse: {
      label: "Use this company",
      help: `Choose the company in ACT! that ${firm} is. PathQuote keeps it for every quote on ${firm}, writes ${firm}'s addresses over that company's in ACT!, and carries on. A company already linked to another PathQuote client cannot be chosen here.`,
      choices: (input.candidates ?? []).map((candidate) => ({
        id: candidate.id,
        line: candidate.takenBy ? `${candidateLine(candidate)} — already PathQuote's client "${candidate.takenBy}"` : candidateLine(candidate),
        taken: candidate.takenBy !== null,
      })),
    },
    companyCreate: {
      label: "Create a new company in ACT!",
      help: `Choose this only if none of the companies listed is ${firm}. PathQuote then creates ${firm} in ACT! at its next send, beside the ones listed, which stay as they are.`,
      confirm: {
        title: `Create ${firm} in ACT!?`,
        description: `Only if none of the companies listed is ${firm}. If one of them is, this puts a second copy of the same company in ACT!, and PathQuote cannot take it out again.`,
        confirmLabel: "Create it in ACT!",
      },
    },
```

with `const firm = input.companyName ?? "this company";` beside `person`.

`adminDoneMessage`'s `action` union gains `"companyUse" | "companyCreate"`, and:

```typescript
    case "companyUse":
      return sendingOn === null
        ? "Linked — this quote, and any other held for this company, go on to ACT! at the next send."
        : sendingOn
          ? "Linked — this quote goes on to ACT! now, or within 15 minutes if another send is under way, and any other quote held for this company within 15 minutes."
          : "Linked — this quote, and any other held for this company, go on to ACT! once sending is switched on.";
    case "companyCreate":
      return `Released — PathQuote creates the company in ACT! ${when}.`;
```

- [ ] **Step 4: The store and the actions** — in `src/lib/act/outbox-admin-store.ts`, extend the imports from `@/lib/act/outbox-admin` with `COMPANY_NOT_HELD_ERROR, companyCreateDecision, companyTakenError, companyUseDecision, heldForCompanyRelease, type AdminCompany, type CompanyWrite`, add `import { readCandidates } from "@/lib/act/company-resolve";`, and append:

```typescript
/** The quote's latest row and its company, as the company decisions read them; null for no such quote. */
async function readCompanyState(documentId: string): Promise<{ row: AdminRow | null; company: AdminCompany | null } | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      company: { select: { id: true, actCompanyId: true, actCompanyHeldAt: true, actCompanyCandidates: true } },
      actOutbox: {
        orderBy: [...LATEST_ROW],
        take: 1,
        select: { id: true, generation: true, completedAt: true, blockedReason: true, blockedBy: true },
      },
    },
  });
  if (!document) return null;
  const company = document.company
    ? {
        id: document.company.id,
        actCompanyId: document.company.actCompanyId,
        actCompanyHeldAt: document.company.actCompanyHeldAt,
        candidates: readCandidates(document.company.actCompanyCandidates),
      }
    : null;
  return { row: document.actOutbox[0] ?? null, company };
}

/** Another PathQuote company carrying this ACT! company, by name; compared without regard to case, as duplicateOf does. */
async function companyTakenBy(actCompanyId: string, exceptCompanyId: string): Promise<string | null> {
  const other = await db.company.findFirst({
    where: { actCompanyId: { equals: actCompanyId, mode: "insensitive" }, id: { not: exceptCompanyId } },
    select: { name: true },
  });
  return other?.name ?? null;
}

/** Thrown inside a company action's transaction to roll it back when the company is no longer held. */
class CompanyNotHeld extends Error {}

/**
 * Settle a held company: its write, and the release of every quote on it
 * held for it (heldForCompanyRelease), in one transaction -- the rows first
 * and the company second, the order in which the drain takes the same two
 * locks before a company POST (setCompanyMarker in src/lib/act/drain.ts).
 */
async function settleCompany(write: CompanyWrite, now: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.actOutbox.findMany({
      where: { completedAt: null, document: { companyId: write.where.id } },
      select: { id: true, generation: true, completedAt: true, blockedReason: true, blockedBy: true },
    });
    for (const release of heldForCompanyRelease(rows, now)) {
      await tx.actOutbox.updateMany(release);
    }
    const { count } = await tx.company.updateMany({
      where: write.where,
      data: { ...write.data, ...(write.clearCandidates ? { actCompanyCandidates: Prisma.DbNull } : {}) },
    });
    if (count !== 1) throw new CompanyNotHeld();
  });
}

/** "Use this company". See companyUseDecision. The unique key is caught for a company taken in between. */
export async function companyUse(documentId: string, actCompanyId: string, now: Date): Promise<AdminOutcome> {
  const state = await readCompanyState(documentId);
  if (!state) return NOT_FOUND;
  const takenBy = state.company ? await companyTakenBy(actCompanyId.trim(), state.company.id) : null;
  const decision = companyUseDecision({ row: state.row, company: state.company, actCompanyId, takenBy });
  if (!decision.ok) return decision;
  try {
    await settleCompany(decision.write, now);
    return { ok: true };
  } catch (error) {
    if (error instanceof CompanyNotHeld) return { ok: false, error: COMPANY_NOT_HELD_ERROR };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && state.company) {
      const late = await companyTakenBy(actCompanyId.trim(), state.company.id);
      if (late) return { ok: false, error: companyTakenError(actCompanyId, late) };
    }
    throw error;
  }
}

/** "Create a new company in ACT!". See companyCreateDecision. */
export async function companyCreate(documentId: string, now: Date): Promise<AdminOutcome> {
  const state = await readCompanyState(documentId);
  if (!state) return NOT_FOUND;
  const decision = companyCreateDecision(state.row, state.company, now);
  if (!decision.ok) return decision;
  try {
    await settleCompany(decision.write, now);
    return { ok: true };
  } catch (error) {
    if (error instanceof CompanyNotHeld) return { ok: false, error: COMPANY_NOT_HELD_ERROR };
    throw error;
  }
}
```

and in the file's header, change "The administrator's four actions" to "The administrator's six actions", adding: "The two company actions call nothing in ACT!: the candidates they choose from came from ACT! when the drain held the company."

In `src/lib/actions/act-outbox.ts`: import `companyCreate, companyUse` from the store; `type Done = "tryAgain" | "contactFound" | "contactAbsent" | "companyUse" | "companyCreate" | "dontSend";`; append:

```typescript
/** "Use this company": the held company is given the ACT! company chosen from those PathQuote listed. */
export async function chooseHeldCompany(documentId: string, actCompanyId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await companyUse(id, String(actCompanyId ?? ""), new Date()), "companyUse");
}

/** "Create a new company in ACT!": the hold ends, and the next send creates the company. */
export async function createHeldCompany(documentId: string): Promise<ActOutboxActionResult> {
  await requireAdmin();
  const id = documentIdOf(documentId);
  if (!id) return { error: NOT_FOUND_ERROR };
  return finish(id, await companyCreate(id, new Date()), "companyCreate");
}
```

- [ ] **Step 5: The query and the card** — in `src/lib/queries/act-quote.ts`: import `readCandidates` from `@/lib/act/company-resolve` and `AdminCompany` (type) from `@/lib/act/outbox-admin`; `QuoteActState` gains `company: AdminCompany | null;`; the document select gains `company: { select: { id: true, name: true, actCompanyId: true, actCompanyHeldAt: true, actCompanyCandidates: true } },`; then before `return`:

```typescript
  const candidates = document.company ? readCandidates(document.company.actCompanyCandidates) : [];
```

`facts` gains

```typescript
      company: document.company
        ? {
            name: document.company.name,
            actCompanyId: document.company.actCompanyId,
            actCompanyHeldAt: document.company.actCompanyHeldAt,
            candidates,
          }
        : null,
```

and the result gains

```typescript
    company: document.company
      ? { id: document.company.id, actCompanyId: document.company.actCompanyId, actCompanyHeldAt: document.company.actCompanyHeldAt, candidates }
      : null,
```

In `src/components/documents/act-state-card.tsx`: `const actions = adminActionsFor(state.row, state.contact, state.company);`; `offered` adds `|| actions.companyUse || actions.companyCreate`; `adminHelpFor({...})` gains `companyName: state.facts.company?.name ?? null, candidates: state.facts.company?.candidates ?? [],`.

In `src/components/documents/act-admin-actions.tsx`: import `chooseHeldCompany, createHeldCompany`; `helpIds` gains `companyUse: useId(), companyCreate: useId(),`; and before the `actions.dontSend` block:

```tsx
      {actions.companyUse ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-brand-dark">{help.companyUse.label}</p>
          <p id={helpIds.companyUse} className="text-xs text-slate-500">
            {help.companyUse.help}
          </p>
          <ul className="flex flex-col gap-1.5">
            {help.companyUse.choices.map((choice) => (
              <li key={choice.id}>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="w-full justify-start text-left whitespace-normal"
                  disabled={pending || choice.taken}
                  aria-describedby={helpIds.companyUse}
                  onClick={() => run(() => chooseHeldCompany(documentId, choice.id))}
                >
                  {choice.line}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {actions.companyCreate ? (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="destructive"
            size="touch"
            className="w-full whitespace-normal"
            disabled={pending}
            aria-describedby={helpIds.companyCreate}
            onClick={() => confirmThen(help.companyCreate.confirm, () => createHeldCompany(documentId))}
          >
            {help.companyCreate.label}
          </Button>
          <p id={helpIds.companyCreate} className="text-xs text-slate-500">
            {help.companyCreate.help}
          </p>
        </div>
      ) : null}
```

and in its comment: "Of the six, the three nothing on the page can take back -- \"ACT! has nobody\", \"Create a new company in ACT!\" and \"Don't send\" -- ask first."

- [ ] **Step 6: Verify**

Run: `npx vitest run tests/act-quote-view.test.ts tests/act-outbox-admin.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test && npm run build`
Expected: PASS; `14`; clean; build succeeds. Then `npm run dev`, open a FINAL quote as an admin, and in a local database set its company held by hand (`UPDATE "Company" SET "actCompanyHeldAt" = now() at time zone 'utc', "actCompanyCandidates" = '[{"id":"c0000000-0000-4000-8000-0000000000e1","name":"Danam Fiji","city":"Suva","country":"Fiji","takenBy":null}]' WHERE id = '<id>'` and its row `"blockedBy" = 'company', "blockedReason" = 'held'`): the card lists the candidate and both buttons, a manager with the ACT! tick sees the sentence only. Revert the rows after.

- [ ] **Step 7: Commit**

```bash
git add src/lib/act/outbox-admin-store.ts src/lib/actions/act-outbox.ts src/lib/act/quote-act-view.ts src/lib/queries/act-quote.ts src/components/documents/act-state-card.tsx src/components/documents/act-admin-actions.tsx tests/act-quote-view.test.ts
git commit -m "act: the quote's ACT! card lists a held company's candidates for an administrator

Name, city and country of each ACT! company PathQuote could not choose
between, each with 'Use this company', and 'Create a new company in ACT!'
behind a confirmation. A candidate another PathQuote client carries is
shown and cannot be chosen. A manager sees the hold and its sentence, which
names the candidates, and no buttons."
```

---

### Task 10: The company steps in the drain

**Files:** modify `src/lib/act/drain.ts`

I/O; the decisions it carries out are Tasks 3, 4 and 7's, already tested. This is the task that turns companies on.

- [ ] **Step 1: Imports** — add:

```typescript
import {
  associationIncludes,
  beforeCompanyCreate,
  candidateOf,
  companyHeldReason,
  companyNamePrefix,
  contactLink,
  fromAssociations,
  fromNameLookup,
  readCandidates,
  type CompanyCandidate,
} from "@/lib/act/company-resolve";
import { sameRecordId } from "@/lib/act/record-write";
```

add `companyAddressPatch, newCompanyBody, type CompanyForAct` to the `@/lib/act/write-payloads` import, and `ActCompany` to the types import.

- [ ] **Step 2: Hand the planner the company** — in `quoteStateOf`, replace the `company: null,` line and its comment with:

```typescript
    company: doc.company
      ? {
          name: doc.company.name,
          actCompanyId: doc.company.actCompanyId,
          heldAt: doc.company.actCompanyHeldAt,
          candidates: readCandidates(doc.company.actCompanyCandidates),
          createChosenAt: doc.company.actCreateChosenAt,
          ownerPendingUserId: doc.company.actOwnerPendingUserId,
        }
      : null,
```

`MAX_STEPS`: 30, its comment's "The longest plan is seven (create-contact through promote-contact)" becoming "The longest plan is fifteen (create-contact through promote-contact, with every owner and company step)".

- [ ] **Step 3: Dispatch** — in `execute`, replace the five-case `throw` added in Task 7 with:

```typescript
      case "resolve-company":
        return this.resolveCompany(row);
      case "create-company":
        return this.createCompany(row);
      case "write-company":
        return this.writeCompany(row);
      case "link-contact-company":
        return this.linkContactCompany(row);
      case "associate-opportunity-company":
        return this.associateOpportunityCompany(row);
```

- [ ] **Step 4: The steps** — add to `Pass`, after `setOwner`/`ownerTarget`:

```typescript
  // --- the company (THE COMPANY in src/lib/act/outbox-plan.ts) ---------------

  /** The quote's company, as the company steps read it: the planner plans none without one. */
  private company(row: Row): NonNullable<Row["document"]["company"]> {
    const company = row.document.company;
    if (!company) throw new Error("the planner planned a company step for a quote with no company");
    return company;
  }

  /** The company's ACT! id: the planner plans no step that needs one without it. */
  private companyActId(row: Row): string {
    const id = row.document.company?.actCompanyId;
    if (!id) throw new Error("the planner planned a step on a company ACT! does not have");
    return id;
  }

  /** The Company row as the bodies take it (CompanyForAct in src/lib/act/write-payloads.ts). */
  private companyForAct(company: NonNullable<Row["document"]["company"]>): CompanyForAct {
    return {
      name: company.name,
      street: company.street,
      city: company.city,
      state: company.state,
      postcode: company.postcode,
      country: company.country,
      deliverySameAsMain: company.deliverySameAsMain,
      deliveryStreet: company.deliveryStreet,
      deliveryCity: company.deliveryCity,
      deliveryState: company.deliveryState,
      deliveryPostcode: company.deliveryPostcode,
      deliveryCountry: company.deliveryCountry,
    };
  }

  /**
   * resolve-company: the contact's associated companies, then ACT!'s
   * companies by name (fromAssociations, fromNameLookup in
   * src/lib/act/company-resolve.ts). One found is stored (adoptCompany);
   * several are held for an administrator (holdCompany); none of the name is
   * the decision to create it, stored as Company.actCreateChosenAt for
   * create-company -- which looks again before it POSTs. A name with nothing
   * to look up is held, with no candidates: never created blind.
   */
  private async resolveCompany(row: Row): Promise<StepOutcome> {
    const company = this.company(row);
    await this.beforeCall();
    const associated = await this.client.contactCompanies(this.contactActId(row));
    const byContact = fromAssociations(associated, company.country);
    if (byContact.kind === "use") return this.adoptCompany(row, company.id, byContact.id, associated, false);
    if (byContact.kind === "hold") return this.holdCompany(company, byContact.candidates);

    const prefix = companyNamePrefix(company.name);
    if (prefix === null) return this.holdCompany(company, []);
    await this.beforeCall();
    const named = await this.client.companiesNamedLike(prefix);
    const verdict = fromNameLookup(named, company.name, company.country);
    switch (verdict.kind) {
      case "use":
        return this.adoptCompany(row, company.id, verdict.id, named, false);
      case "hold":
        return this.holdCompany(company, verdict.candidates);
      case "create": {
        const { count } = await db.company.updateMany({
          where: { id: company.id, actCompanyId: null, actCompanyHeldAt: null },
          data: { actCreateChosenAt: this.clock() },
        });
        return count === 1 ? "stored" : "stale";
      }
    }
  }

  /**
   * Store the ACT! company found as Company.actCompanyId, ending any hold, a
   * decision to create and a create in flight. `ours`: the company is the
   * one PathQuote's own lost POST made, and is given its owner like any it
   * makes (OWNER BY NAME). An ACT! company another PathQuote company already
   * carries -- Company.actCompanyId is unique -- is held instead, naming that
   * client. Guarded on no ACT! company yet; a unique-key race is `stale`,
   * and the next plan meets the other company and holds.
   */
  private async adoptCompany(
    row: Row,
    companyId: string,
    actCompanyId: string,
    rows: readonly ActCompany[],
    ours: boolean,
  ): Promise<StepOutcome> {
    const company = this.company(row);
    const taken = await db.company.findFirst({
      where: { actCompanyId: { equals: actCompanyId, mode: "insensitive" }, id: { not: companyId } },
      select: { name: true },
    });
    if (taken) {
      const found = rows.find((r) => typeof r.id === "string" && sameRecordId(r.id, actCompanyId)) ?? { id: actCompanyId, name: null, address: null };
      return this.holdCompany(company, [candidateOf(found, taken.name)]);
    }
    const author = row.document.author.actUserId;
    try {
      const { count } = await db.company.updateMany({
        where: { id: companyId, actCompanyId: null },
        data: {
          actCompanyId,
          actCompanyHeldAt: null,
          actCompanyCandidates: Prisma.DbNull,
          actCreateChosenAt: null,
          actCreateInFlightAt: null,
          ...(ours && author ? { actOwnerPendingUserId: author } : {}),
        },
      });
      return count === 1 ? "stored" : "stale";
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "stale";
      throw error;
    }
  }

  /**
   * Hold the company for an administrator: the candidates and the time on
   * the Company, guarded on no ACT! company yet, then this row blocked
   * "company" with the sentence nextStep gives every quote on it from now on
   * (companyHeldReason). Two statements, the Company first: a row write that
   * finds the row taken over leaves the hold, and the planner blocks the row
   * from it on the next plan.
   */
  private async holdCompany(company: NonNullable<Row["document"]["company"]>, candidates: CompanyCandidate[]): Promise<never> {
    await db.company.updateMany({
      where: { id: company.id, actCompanyId: null },
      data: { actCompanyHeldAt: this.clock(), actCompanyCandidates: candidates as unknown as Prisma.InputJsonValue },
    });
    console.warn("act: the quote's company is held for an administrator", { companyId: company.id, candidates: candidates.length });
    throw new BlockRow(companyHeldReason(company.name, candidates), BLOCKED_BY.company);
  }

  /**
   * create-company (A COMPANY CREATE IN FLIGHT in src/lib/act/outbox-plan.ts):
   * the name looked up first, as before every company POST, and a company of
   * it nobody has seen used or held (beforeCompanyCreate) -- `seen` being the
   * candidates an administrator chose to create beside, `inFlight` the
   * marker. Then the marker, the POST and the id: the marker set by
   * setCompanyMarker, which sends nothing when the row was taken over or the
   * company has its ACT! company; cleared with the id, or when the POST made
   * nothing (createMadeNothing); kept on anything else, for the next
   * attempt's lookup to settle. A name with nothing to look up -- held with
   * no candidates, then released by an administrator -- is POSTed without
   * the lookup it cannot have.
   */
  private async createCompany(row: Row): Promise<StepOutcome> {
    const company = this.company(row);
    const prefix = companyNamePrefix(company.name);
    if (prefix !== null) {
      await this.beforeCall();
      const named = await this.client.companiesNamedLike(prefix);
      const verdict = beforeCompanyCreate({
        rows: named,
        name: company.name,
        country: company.country,
        seen: readCandidates(company.actCompanyCandidates).map((candidate) => candidate.id),
        inFlight: company.actCreateInFlightAt !== null,
      });
      if (verdict.kind === "use") return this.adoptCompany(row, company.id, verdict.id, named, verdict.ours);
      if (verdict.kind === "hold") return this.holdCompany(company, verdict.candidates);
    }

    const body = newCompanyBody(this.companyForAct(company), await this.countries());
    await this.beforeCall();
    const marker = this.clock();
    if (!(await this.setCompanyMarker(row, company.id, marker))) return "stale";
    let created: ActCompany;
    try {
      created = await this.client.createCompany(body);
    } catch (error) {
      if (error instanceof ActUntrackedCreateError && error.createdId) {
        console.warn("act: a company create's answer could not be read back; storing the id ACT! gave", { id: row.id, createdId: error.createdId });
        return this.storeCompanyCreated(row, company.id, error.createdId);
      }
      if (createMadeNothing(error)) await this.clearCompanyMarker(company.id, marker);
      else if (createUnaccounted(error)) {
        console.warn("act: ACT! may have created this company; the next attempt looks it up by name before creating anything", {
          id: row.id,
          companyId: company.id,
          error,
        });
      }
      throw error;
    }
    return this.storeCompanyCreated(row, company.id, created.id);
  }

  /**
   * Mark the company's create in flight, before its POST: one transaction, a
   * write to the row guarded as storeRow's first (no row means taken over,
   * and nothing is sent -- requirement 1), then the marker, while the
   * company has no ACT! company. A marker already there is replaced: the
   * lookup just made found nothing it has not seen, so whatever the earlier
   * POST did is accounted for. The row first, the company second: the order
   * settleCompany in src/lib/act/outbox-admin-store.ts takes them in.
   */
  private async setCompanyMarker(row: Row, companyId: string, at: Date): Promise<boolean> {
    return db.$transaction(async (tx) => {
      const own = await tx.actOutbox.updateMany({
        where: { id: row.id, generation: row.generation, completedAt: null },
        data: { generation: row.generation },
      });
      if (own.count === 0) {
        console.info("act: outbox row taken over while the drain worked it; planning it again", { id: row.id });
        return false;
      }
      const marked = await tx.company.updateMany({ where: { id: companyId, actCompanyId: null }, data: { actCreateInFlightAt: at } });
      return marked.count === 1;
    });
  }

  /** Clear the company's marker after a POST that made nothing: only the one this step set. */
  private clearCompanyMarker(companyId: string, at: Date) {
    return db.company.updateMany({ where: { id: companyId, actCreateInFlightAt: at }, data: { actCreateInFlightAt: null } });
  }

  /**
   * The created company's id on the Company, with its pending owner (the
   * author's ACT! user, when they have one), the marker, the decision and
   * the candidates cleared, in one update. If it fails, ACT! holds a company
   * PathQuote has not recorded: the marker stays, the ACT! id is logged, and
   * the row backs off; its next attempt's lookup finds that company -- the
   * only unseen one of the name -- and adopts it as PathQuote's own.
   */
  private async storeCompanyCreated(row: Row, companyId: string, actCompanyId: string): Promise<StepOutcome> {
    const author = row.document.author.actUserId;
    try {
      await db.company.update({
        where: { id: companyId },
        data: {
          actCompanyId,
          actCreateInFlightAt: null,
          actCreateChosenAt: null,
          actCompanyHeldAt: null,
          actCompanyCandidates: Prisma.DbNull,
          ...(author ? { actOwnerPendingUserId: author } : {}),
        },
      });
    } catch (error) {
      console.error("act: ACT! created a company whose id PathQuote could not store; the company stays marked in flight", {
        id: row.id,
        companyId,
        actCompanyId,
        error,
      });
      throw error;
    }
    return "stored";
  }

  /**
   * write-company: both addresses, decided on the company as read
   * (companyAddressPatch in src/lib/act/write-payloads.ts) and written whole
   * -- or nothing sent, when ACT! already reads so (patchToSend). Then the
   * row's companyWrittenAt, guarded like every row store. No snapshot: the
   * inbound sync reads contacts, never a company, so a company write is no
   * echo to it.
   */
  private async writeCompany(row: Row): Promise<StepOutcome> {
    const company = this.company(row);
    const id = this.companyActId(row);
    const items = await this.countries();
    await this.beforeCall();
    await this.client.updateCompany(id, (current) =>
      companyAddressPatch(this.companyForAct(company), items, current as unknown as Record<string, unknown>),
    );
    return (await this.storeRow(row, { companyWrittenAt: this.clock() })) ? "stored" : "stale";
  }

  /**
   * link-contact-company (C5): the contact's associated companies read; only
   * when there are none, the association PUT and read back. A contact
   * associated with any company is left as it is. Then
   * Contact.actCompanyLinkedFor. After a PUT the contact is read again and
   * stored as its ActSnapshot, its `edited` as actSourceEditedAt: a link may
   * move the contact's `edited`, and this is the baseline the next inbound
   * sync compares (changedInAct in src/lib/act/merge.ts), so the link does
   * not come back as an edit. An association ACT! answers but does not list
   * fails the step, to be tried again.
   */
  private async linkContactCompany(row: Row): Promise<StepOutcome> {
    const contact = row.document.contact;
    if (!contact) throw new Error("the planner planned link-contact-company for a quote with no contact");
    const contactActId = this.contactActId(row);
    const companyActId = this.companyActId(row);
    await this.beforeCall();
    const link = contactLink(await this.client.contactCompanies(contactActId));
    let record: ActContact | null = null;
    if (link.kind === "link") {
      await this.beforeCall();
      await this.client.associateContactCompany(contactActId, companyActId);
      await this.beforeCall();
      if (!associationIncludes(await this.client.contactCompanies(contactActId), companyActId)) {
        throw new Error(`ACT! answered the link of contact ${contactActId} to company ${companyActId} but does not list it`);
      }
      await this.beforeCall();
      record = await this.client.getContact(contactActId);
    } else if (!link.associated.some((id) => sameRecordId(id, companyActId))) {
      console.info("act: the contact is associated with another company in ACT!; left as it is (C5)", {
        id: row.id,
        associated: link.associated,
      });
    }
    const edited = record ? editedAt(record) : null;
    const payload = record as unknown as Prisma.InputJsonValue;
    await db.$transaction([
      db.contact.update({
        where: { id: contact.id },
        data: {
          actCompanyLinkedFor: companyActId,
          ...(record ? { actSyncedAt: new Date(), ...(edited ? { actSourceEditedAt: edited } : {}) } : {}),
        },
      }),
      ...(record
        ? [db.actSnapshot.upsert({ where: { contactId: contact.id }, create: { contactId: contact.id, payload }, update: { payload } })]
        : []),
    ]);
    return "stored";
  }

  /**
   * associate-opportunity-company: the opportunity's associated companies
   * read; the association PUT and read back only when the company is not
   * among them -- an opportunity created with `companies` may already be
   * (spec section 3.4 left that untested). Then
   * Document.actOpportunityCompanyId. No snapshot: the inbound sync never
   * reads an opportunity.
   */
  private async associateOpportunityCompany(row: Row): Promise<StepOutcome> {
    const opportunityId = this.opportunityId(row);
    const companyActId = this.companyActId(row);
    await this.beforeCall();
    if (!associationIncludes(await this.client.opportunityCompanies(opportunityId), companyActId)) {
      await this.beforeCall();
      await this.client.associateOpportunityCompany(opportunityId, companyActId);
      await this.beforeCall();
      if (!associationIncludes(await this.client.opportunityCompanies(opportunityId), companyActId)) {
        throw new Error(`ACT! answered the link of opportunity ${opportunityId} to company ${companyActId} but does not list it`);
      }
    }
    await db.document.update({ where: { id: row.document.id }, data: { actOpportunityCompanyId: companyActId } });
    return "stored";
  }
```

In the drain's header, after "THREE CALLERS." paragraph, add:

```typescript
// THE COMPANY STEPS hold a quote for an administrator (blockedBy "company")
// when ACT!'s companies cannot be told apart; the quote's ACT! card is where
// it is settled (src/lib/act/outbox-admin.ts). Nothing they write to ACT! is
// a contact field the inbound sync reads, but a link may move a contact's
// `edited`, and so may its owner: both store the contact as read back, as a
// create does.
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test && npm run build`
Expected: clean; `14`; all pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/act/drain.ts
git commit -m "act: every quote's contact ends up on a real ACT! company carrying PathQuote's addresses

The drain now hands the planner the quote's company and carries out its
steps: the contact's associated companies, then ACT!'s by name; one found is
stored on the PathQuote company for every quote on it, none is created --
looked up again just before -- and several are held for an administrator.
Both addresses are overwritten on every row, the contact linked when ACT!
links it to nothing, and the opportunity associated when it is not.

A company created with its answer lost is never created again: the lookup
before every company POST finds the one it made and adopts it, owner and
all."
```

---

### Task 11: The preflight: the company filter, and the owners

**Files:** modify `src/lib/act/write-preflight.ts`, `scripts/act-write-preflight.ts`, `tests/act-write-preflight.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/act-write-preflight.test.ts` (import `NONSENSE_COMPANY_PREFIX, companyFilterCheck, ownersCheck` from the preflight module):

```typescript
describe("check 11: the company name filter", () => {
  const KNOWN = { name: "Flynt Amtex Inc", actCompanyId: "c0000000-0000-4000-8000-0000000000e1", prefix: "Flynt" };

  it("passes when nothing comes back for a name nobody has, and the known company comes back by its PathQuote name", () => {
    const check = companyFilterCheck({
      nonsense: ok([]),
      known: { ...KNOWN, rows: ok([{ id: KNOWN.actCompanyId, name: "Flynt Amtex Inc." }, { id: "x", name: "FLYNT Logistics" }]) },
    });
    expect(check).toMatchObject({ number: 11, status: "PASS" });
  });

  it("fails when ACT! ignores the filter", () => {
    expect(companyFilterCheck({ nonsense: ok([{ id: "x", name: "Anything" }]), known: null }).status).toBe("FAIL");
  });

  it("fails when ACT! refuses it: resolve-company has no other way to find a company", () => {
    expect(companyFilterCheck({ nonsense: failed({ status: 400, filterRefused: true }), known: null }).status).toBe("FAIL");
  });

  it("fails when rows come back that do not start with what was asked for", () => {
    const check = companyFilterCheck({ nonsense: ok([]), known: { ...KNOWN, rows: ok([{ id: KNOWN.actCompanyId, name: "Flynt Amtex" }, { id: "y", name: "Acme" }]) } });
    expect(check.status).toBe("FAIL");
  });

  it("warns when the filter works but the PathQuote name does not find ACT!'s record", () => {
    const check = companyFilterCheck({ nonsense: ok([]), known: { ...KNOWN, rows: ok([{ id: "x", name: "Flynt Logistics" }]) } });
    expect(check.status).toBe("WARN");
  });

  it("warns, inconclusive, with no known company to try", () => {
    expect(companyFilterCheck({ nonsense: ok([]), known: null }).status).toBe("WARN");
  });

  it("asks for a name no company has", () => {
    expect(NONSENSE_COMPANY_PREFIX).toMatch(/^zz/);
  });
});

describe("check 12: owners by name", () => {
  const users: PathQuoteUser[] = [
    { email: "enrico@example.com", role: "MANAGER", active: true, actUserId: "a1", actAccountMgr: null },
    { email: "dist@example.com", role: "MANAGER", active: true, actUserId: null, actAccountMgr: null },
    { email: "gone@example.com", role: "MANAGER", active: false, actUserId: "a9", actAccountMgr: null },
  ];

  it("passes when every linked active user has a name in ACT!, saying who owns what an unlinked author writes", () => {
    const check = ownersCheck(ok([{ id: "a1", username: "Enrico Zamarra", status: "Inactive" }]), users, "John Hollo");
    expect(check).toMatchObject({ number: 12, status: "PASS" });
    expect(check.details).toContain("enrico@example.com -> Enrico Zamarra (Inactive)");
    expect(check.details.join("\n")).toContain('1 active user has no ACT! user: what they create stays owned by the login, "John Hollo"');
  });

  it("warns, naming them, for linked users ACT! lists under no name", () => {
    const check = ownersCheck(ok([]), users, "John Hollo");
    expect(check.status).toBe("WARN");
    expect(check.details).toContain("enrico@example.com: ACT! user a1 is not among ACT!'s users");
  });

  it("fails when ACT!'s users could not be read", () => {
    expect(ownersCheck(failed(), users, "John Hollo").status).toBe("FAIL");
  });
});

describe("check 8: a quote held for its company", () => {
  it("is listed as held for its company", () => {
    expect(backlogState({ blockedReason: "held", blockedBy: "company", nextAttemptAt: new Date() }, new Date())).toBe("held for its company");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-write-preflight.test.ts`
Expected: FAIL — `companyFilterCheck is not a function`; backlogState returns `"held"`.

- [ ] **Step 3: Implement** — in `src/lib/act/write-preflight.ts`:

Header list: add

```typescript
//   11  the company lookup's `startswith` filter, and a known company found
//       by its PathQuote name
//   12  every linked user's ACT! name, which owners are set by
```

Imports: add `import { actUserName } from "@/lib/act/record-owner";`. (The company filter itself is built by the script, from `companyNameFilter`, so that it is the drain's own request.)

`BacklogState`: add `| "held for its company"`; `backlogState`: `case "company": return "held for its company";` after `"contact"`.

Before `// --- the report`:

```typescript
// --- 11 the company name filter ------------------------------------------------

/** A prefix no ACT! company's name starts with: what check 11 asks for first. */
export const NONSENSE_COMPANY_PREFIX = "zzPathQuotePreflightNoSuchCompany";

export type CompanyFilterInput = {
  /** `GET /api/companies` with the lookup's query, for NONSENSE_COMPANY_PREFIX. */
  nonsense: Read<readonly Row[]>;
  /**
   * A PathQuote company that carries an ACT! company id, with the prefix the
   * drain would ask for its name (companyNamePrefix) and ACT!'s answer to the
   * lookup for it; null when no PathQuote company has an ACT! id.
   */
  known: { name: string; actCompanyId: string; prefix: string | null; rows: Read<readonly Row[]> | null } | null;
};

const TITLE_11 = "Company name filter";

/**
 * Before every company is found or created, the drain asks ACT! for the
 * companies whose name starts with the PathQuote name's first word
 * (companiesNamedLike in src/lib/act/client.ts), with `$top` LOOKUP_TOP, and
 * compares names itself (fromNameLookup in src/lib/act/company-resolve.ts).
 * Verified once by the company probe (2026-10-16); this checks it still is.
 *
 *   nonsense refused, or failed      FAIL: no company could be resolved --
 *                                    there is no fallback to look through
 *   nonsense answered with rows      FAIL: the filter is ignored
 *   a row not starting with the      FAIL: the filter is not what the
 *   prefix asked for                 lookup needs
 *   the known company missing        WARN: the filter works, but this
 *                                    company's PathQuote name does not find
 *                                    ACT!'s record (its quotes still find it
 *                                    by the id PathQuote stores)
 *   no known company, or no prefix   WARN, inconclusive
 *   otherwise                        PASS
 */
export function companyFilterCheck(input: CompanyFilterInput): Check {
  const { nonsense } = input;
  if (!nonsense.ok) {
    if (nonsense.failure.filterRefused) {
      return {
        number: 11,
        title: TITLE_11,
        status: "FAIL",
        reason: `ACT! refused the companies filter (${nonsense.failure.status}): resolve-company has no other way to find a company by name, so every quote with a company would be held`,
        details: [nonsense.failure.message],
        todo: ["Do not switch sending on until the company lookup (companiesNamedLike in src/lib/act/client.ts) has another way to ask."],
      };
    }
    return couldNotRead(11, TITLE_11, "the drain's company lookup", nonsense.failure);
  }
  if (nonsense.value.length > 0) {
    return {
      number: 11,
      title: TITLE_11,
      status: "FAIL",
      reason: `ACT! ignored $filter on /api/companies: asked for a name no company has, it answered with ${plural(nonsense.value.length, "company", "companies")}`,
      details: [],
      todo: ["Do not switch sending on: every company would be compared against the whole list, and a duplicate created where the list was cut short."],
    };
  }
  const known = input.known;
  if (!known || known.prefix === null || known.rows === null) {
    return {
      number: 11,
      title: TITLE_11,
      status: "WARN",
      reason: "inconclusive: nothing for a name nobody has is what a working filter gives, but there was no known company to try a real name on",
      details: known ? [`"${known.name}" has nothing to look up by`] : ["no PathQuote company carries an ACT! company id"],
      todo: ["Run the preflight again once a quote's company has reached ACT!."],
    };
  }
  const rows = known.rows;
  if (!rows.ok) return couldNotRead(11, TITLE_11, `the lookup for "${known.prefix}"`, rows.failure);
  const prefix = known.prefix.toLowerCase();
  const strays = rows.value.filter((row) => !(text(row.name)?.toLowerCase().startsWith(prefix) ?? false));
  const details = [`asked for names starting "${known.prefix}" (from "${known.name}"): ${plural(rows.value.length, "company", "companies")}`];
  if (strays.length > 0) {
    return {
      number: 11,
      title: TITLE_11,
      status: "FAIL",
      reason: `ACT! answered with ${plural(strays.length, "company", "companies")} whose name does not start with "${known.prefix}": the filter is not applied as the lookup needs`,
      details: [...details, ...strays.slice(0, 5).map((row) => `other name: ${JSON.stringify(row.name)}`)],
      todo: ["Do not switch sending on until the company lookup has been looked at again (companiesNamedLike in src/lib/act/client.ts)."],
    };
  }
  const found = rows.value.some((row) => {
    const id = text(row.id);
    return id !== null && sameRecordId(id, known.actCompanyId);
  });
  if (!found) {
    return {
      number: 11,
      title: TITLE_11,
      status: "WARN",
      reason: `the filter works, but "${known.name}" does not find its own ACT! company (${known.actCompanyId}) by name: ACT! spells it differently`,
      details,
      todo: [
        "Nothing to fix for this company -- its quotes use the ACT! id PathQuote stores. A NEW company named this differently from ACT! would be created a second time; compare the two names.",
      ],
    };
  }
  return {
    number: 11,
    title: TITLE_11,
    status: "PASS",
    reason: `ACT! applies the filter: nothing for a name nobody has, and "${known.name}" finds its own ACT! company`,
    details,
    todo: [],
  };
}

// --- 12 owners by name --------------------------------------------------------------

const TITLE_12 = "Owners by name";

/**
 * Every active PathQuote user linked to an ACT! user (User.actUserId) owns
 * what the drain creates for their quotes, BY NAME (actUserName in
 * src/lib/act/record-owner.ts): an id ACT! no longer lists, or one with no
 * name, leaves their records to the login. An unlinked author's records are
 * the login's by decision O1, and are counted, not warned about. A History is
 * always the login's: ACT! does not let it be re-owned.
 *
 *   users not read        FAIL
 *   a linked user with    WARN, naming them
 *   no name in ACT!
 *   otherwise             PASS
 */
export function ownersCheck(actUsers: Read<readonly Row[]>, users: readonly PathQuoteUser[], login: string): Check {
  if (!actUsers.ok) return couldNotRead(12, TITLE_12, "reading ACT!'s users", actUsers.failure);
  const active = users.filter((user) => user.active);
  const linked = active.filter((user): user is PathQuoteUser & { actUserId: string } => user.actUserId !== null);
  const unlinked = active.length - linked.length;
  const named = linked.map((user) => ({ user, name: actUserName(actUsers.value, user.actUserId) }));
  const missing = named.filter(({ name }) => name === null);
  const status = (id: string) => {
    const row = actUsers.value.find((r) => typeof r.id === "string" && sameRecordId(r.id, id));
    return text(row?.status) ?? "status unknown";
  };
  const details = [
    ...named
      .filter(({ name }) => name !== null)
      .map(({ user, name }) => `${user.email} -> ${name} (${status(user.actUserId)})`),
    ...missing.map(({ user }) => `${user.email}: ACT! user ${user.actUserId} is not among ACT!'s users`),
    `${plural(unlinked, "active user has", "active users have")} no ACT! user: what they create stays owned by the login, "${login}" (decision O1)`,
    "Every History is owned by the login: ACT! does not let a History be re-owned.",
  ];
  if (missing.length > 0) {
    return {
      number: 12,
      title: TITLE_12,
      status: "WARN",
      reason: `${plural(missing.length, "linked user has", "linked users have")} no name in ACT!: what the drain creates for their quotes stays owned by the login`,
      details,
      todo: ["Link them again in Settings -> Users -> <user> -> ACT!, to a user ACT! lists."],
    };
  }
  return {
    number: 12,
    title: TITLE_12,
    status: "PASS",
    reason: `every linked active user (${formatCount(linked.length)}) has a name in ACT! to own their records by`,
    details,
    todo: [],
  };
}
```

(`text` and `sameRecordId` are already in this module's scope.)

- [ ] **Step 4: The script** — in `scripts/act-write-preflight.ts`:

Header list: add lines 11 and 12 as in the module. Imports: add `companyFilterCheck, ownersCheck, NONSENSE_COMPANY_PREFIX` from the preflight module, `companyNameFilter, companyNamePrefix` from `../src/lib/act/company-resolve`.

`PathQuoteFacts` gains `knownCompany: { name: string; actCompanyId: string } | null;`, read in the READ ONLY transaction:

```typescript
        const known = await tx.company.findFirst({
          where: { actCompanyId: { not: null } },
          orderBy: { name: "asc" },
          select: { name: true, actCompanyId: true },
        });
```

returned as `knownCompany: known?.actCompanyId ? { name: known.name, actCompanyId: known.actCompanyId } : null`.

`checkAct` takes `knownCompany` as a fourth parameter; its early return adds `notAsked(11, "Company name filter"), notAsked(12, "Owners by name"),`; before `const stages`:

```typescript
  // 11: the drain's company lookup, for a name nobody has, then for a known
  // company's PathQuote name.
  const companyNonsense = await read(() => act.rows("/api/companies", lookupQuery(companyNameFilter(NONSENSE_COMPANY_PREFIX))));
  const prefix = knownCompany ? companyNamePrefix(knownCompany.name) : null;
  const known = knownCompany
    ? {
        ...knownCompany,
        prefix,
        rows: prefix ? await read(() => act.rows("/api/companies", lookupQuery(companyNameFilter(prefix)))) : null,
      }
    : null;
```

and the returned list adds `companyFilterCheck({ nonsense: companyNonsense, known }), ownersCheck(actUsers, users, act.loginName),`. In `main`, pass `pathQuote.knownCompany`.

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/act-write-preflight.test.ts && npx tsc --noEmit -p . && npx tsc -p tests --noEmit 2>&1 | grep -c "error TS" && npm run lint && npm test`
Expected: PASS (11 new tests); `14`; clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/act/write-preflight.ts scripts/act-write-preflight.ts tests/act-write-preflight.test.ts
git commit -m "act:write-preflight checks the company lookup and the owners

Check 11 sends the drain's own company lookup for a name nobody has and for
a known company's PathQuote name: the filter must be honoured, and refused
is a FAIL, since there is nothing to fall back on. Check 12 lists the name
each linked user's records will be owned by, warns for a link ACT! no
longer knows, and counts the unlinked authors whose records stay the
login's. A quote held for its company is listed as such."
```

---

### Task 12: `act:show-quote` shows the company and the owners

**Files:** modify `scripts/act-show-quote.ts`

- [ ] **Step 1: Implement** — in `scripts/act-show-quote.ts`:

After the `show("actContactPromotedForId", …)` line:

```typescript
    show("actOpportunityCompanyId", doc.actOpportunityCompanyId);
    show("opportunity owner pending", doc.actOpportunityOwnerPendingUserId);
    if (doc.company) {
      show("company held at", doc.company.actCompanyHeldAt?.toISOString());
      show("company candidates", doc.company.actCompanyCandidates);
      show("company create chosen", doc.company.actCreateChosenAt?.toISOString());
      show("company create in flight", doc.company.actCreateInFlightAt?.toISOString());
      show("company owner pending", doc.company.actOwnerPendingUserId);
    }
    if (doc.contact) {
      show("contact owner pending", doc.contact.actOwnerPendingUserId);
      show("contact linked for", doc.contact.actCompanyLinkedFor);
    }
```

In the outbox rows loop, add `  companyWritten=${row.companyWrittenAt?.toISOString() ?? "-"}` to the printed line.

In the ACT! opportunity block, after `show("companies", …)`:

```typescript
      const oppCompanies = (await act.opportunityCompanies(doc.actOpportunityId)) as unknown as Record<string, unknown>[];
      show("associated companies", oppCompanies.map((c) => `${c.name} (${c.id})`).join(" | ") || "-");
```

In the ACT! contact block, add `"recordManager"` to the picked fields, and:

```typescript
      const associated = (await act.contactCompanies(doc.contact.actContactId)) as unknown as Record<string, unknown>[];
      show("associated companies", associated.map((c) => `${c.name} (${c.id})`).join(" | ") || "-");
```

After the contact block:

```typescript
    if (doc.company?.actCompanyId) {
      console.log("\nACT! company");
      const company = (await act.getCompany(doc.company.actCompanyId)) as unknown as Record<string, unknown>;
      pick(company, ["name", "recordManager", "recordManagerID", "edited"]);
      show("address", company.address);
      show("shippingAddress", company.shippingAddress);
    } else {
      console.log("\nACT! company: none stored");
    }
```

Update the header comment: "…the contact (company field, associated companies, ID/Status, Acc Mgr, owner), and the ACT! company (its name, both addresses and its owner)."

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit -p . && npm run lint`
Expected: clean. (It talks to ACT!, so it is run on the VPS only: see the checklist below.)

- [ ] **Step 3: Commit**

```bash
git add scripts/act-show-quote.ts
git commit -m "act:show-quote prints the quote's ACT! company, its owner and every association

The company's name, business and shipping address and owner as ACT! holds
them; the contact's and the opportunity's associated companies; and what
PathQuote stored about each step -- held, chosen, in flight, owner
pending -- so a test quote can be checked against ACT! itself."
```

---

### Task 13: The runbook and the reference

**Files:** modify `docs/runbook.md`, `docs/act-integration-reference.md`

- [ ] **Step 1: Runbook §4d** — insert before `### Alerts` in §4d:

````markdown
### Companies and owners (since 2026-10-16)

Every quote's contact ends up associated with a real ACT! Company carrying PathQuote's business and shipping address, and the deal's opportunity is associated with it too; what PathQuote creates is owned by the quote's author. Decisions: `docs/superpowers/specs/2026-10-15-act-write-back-companies.md`. Order of a row's steps: the header of `src/lib/act/outbox-plan.ts`.

**Which ACT! company.** `Company.actCompanyId` when set — shared by every quote on that PathQuote client. Otherwise the ACT! contact's associated companies, then ACT!'s companies by name (`startswith` on the first word, names compared with legal form and punctuation folded). One → used. Several → narrowed by country. None of the name → created (looked up once more just before). Still several → **held for an administrator**.

**Addresses.** Written from PathQuote on every finalise, signature and acceptance: main → business, delivery → shipping (main again when there is no separate delivery address). PathQuote is the master: a field blank in PathQuote clears ACT!'s. An address PathQuote has nothing for is left alone. The name is never written.

**Owners.** The author's ACT! user (Settings → Users → ACT!), by name, on every contact, company and opportunity PathQuote creates. An unlinked author's records stay owned by the login (`ACT_USER`, John Hollo). History is always the login's — ACT! cannot re-own it.

**A quote held for its company** shows "ACT! has N companies that could be …". An administrator chooses on the quote's ACT! card: **Use this company** (one of those listed) or **Create a new company in ACT!**. Every quote on that client is released together. Find them all:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c \
  "select c.id, c.name, c.\"actCompanyHeldAt\", c.\"actCompanyCandidates\" from \"Company\" c where c.\"actCompanyHeldAt\" is not null and c.\"actCompanyId\" is null;"
```

A candidate marked "already PathQuote's client X" is an ACT! company another PathQuote client carries: the two PathQuote clients are probably one firm. Merging them is the developer's; until then the administrator can only create a new ACT! company.

When the app cannot be used, the SQL behind **Use this company** (the id from the candidates; nothing else changes, and the next pass carries on):

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c \
  "UPDATE \"Company\" SET \"actCompanyId\" = '<act company id>', \"actCompanyHeldAt\" = NULL, \"actCompanyCandidates\" = NULL, \"actCreateChosenAt\" = NULL, \"actCreateInFlightAt\" = NULL WHERE id = '<company id>' AND \"actCompanyId\" IS NULL;"
```

**A company create whose answer was lost** needs nothing: the next attempt looks the name up before it POSTs, adopts the one ACT! made, and gives it its owner. If several of that name are there by then, the quote is held as above.

**A finished quote** (e.g. Danam, Q-AU-2026-002) gets its company at its next event — signature, acceptance, or unfinalise/finalise. "Try again now" only applies to an unfinished row.

**Checking a quote:** `TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:show-quote -- <quote number>` prints the ACT! company, both addresses, its owner, and the contact's and opportunity's associated companies. `npm run act:write-preflight` checks 11 (the company filter) and 12 (owners) say whether the live ACT! still behaves as probed.
````

Also add `Company name filter` and `Owners by name` to §4d's list of preflight checks under "Before switching it on" (checks 11 and 12), and to "Things copied from ACT! by hand" nothing (no new transcribed values).

- [ ] **Step 2: Reference** — in `docs/act-integration-reference.md`:

§3 table: change the "Link contact ↔ company" row to `` `GET /api/contacts/{contactId}/associated-companies` · `PUT,DELETE /api/contacts/{contactId}/associated-companies/{companyId}` — **verified 2026-10-16**: PUT with no body associates; `company` text and `companyID` unchanged ``; add a row `| Link opportunity ↔ company | GET /api/opportunities/{id}/associated-companies · PUT /api/opportunities/{id}/associated-companies/{companyId} — verified 2026-10-16 |`; and under the table: "On `/api/companies`, `$filter` with `eq`, `startswith` and `contains` on `name` is honoured and case-insensitive (2026-10-16); PathQuote's lookup uses `startswith` (`companyNameFilter` in `src/lib/act/company-resolve.ts`)."

§5: after the table, add: "**Written by PathQuote since 2026-10-16:** `name` on create only; `address` and `shippingAddress` overwritten from PathQuote's main and delivery address on every finalise, signature and acceptance (country as a Countries picklist item); `recordManager` by name after a create. Addresses read back with `latitude`/`longitude`, which PathQuote keeps and never compares. A contact's link to its company is an association, never `companyID`."

§9: add a subsection:

```markdown
### Owners by name

ACT! ignores `recordManagerID` on a create and on a PATCH — every record comes back owned by the login. A partial `PATCH {id, recordManager: "<user name>"}` is taken on a contact, a company and an opportunity, for an Inactive user too, and `recordManagerID` follows. A History cannot be re-owned (200, unchanged). The name is the user's `username` from `GET /api/users`, else `displayName` (`actUserName` in `src/lib/act/record-owner.ts`). Probed 2026-10-16 with `npm run act:company-probe -- --owner-all`.
```

§12 (source files): add `src/lib/act/company-resolve.ts` and `src/lib/act/record-owner.ts` with one line each.

- [ ] **Step 3: Commit**

```bash
git add docs/runbook.md docs/act-integration-reference.md
git commit -m "docs(act): companies and owners in the runbook and the API reference

How the quote's ACT! company is chosen, what is written to it, who owns
what PathQuote creates, how an administrator settles a held company (and
the SQL for when the app cannot), and the endpoints and behaviour the
company probe verified on 2026-10-16."
```

---

## Verification on production (Vadym)

The API answers only the VPS, so the first real company write happens there. Every command from `/opt/pathquote`, `TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run …`.

**Before:**

- [ ] Deploy outside the 03:00 sync (the migration's `ADD COLUMN`s wait on locks). Switch sending **off** (Settings → ACT! sync) for the deploy and the preflight.
- [ ] `npm run act:write-preflight`: checks 11 and 12 PASS (12 lists Enrico Zamarra as Inactive — expected); nothing else newly FAILs. Read the backlog (check 8): every quote listed will now also resolve its company.
- [ ] Decide what happens to the backlog, then switch sending **on**.

**Scenarios** — each on a test quote (number below), checked with `npm run act:show-quote -- <number>` and in ACT! itself:

- [ ] **1. A new company not in ACT!** — a test company in PathQuote with a main address of two street lines and a *different* delivery address; a new contact; author linked to ACT!. Finalise. Expect: one new ACT! company, its name as PathQuote's, business address = main (two lines, city, postcode, country), shipping address = delivery; the contact created and **associated** with it (contact's `company` text set, `companyID` empty); the opportunity associated with it; contact, company and opportunity owned by the author; the History owned by John Hollo. Finalise again unchanged: no second company, contact or opportunity, and the company's `edited` unchanged (nothing to write).
- [ ] **2. A company ACT! has under a slightly different name** — create "PQ Test Co Pty. Ltd." in ACT! by hand; in PathQuote a company "PQ Test Co Pty Ltd" with no ACT! id. Finalise. Expect: no new company; `actCompanyId` = the hand-made one; its addresses overwritten from PathQuote; its owner unchanged (PathQuote did not make it).
- [ ] **3. An ambiguous name** — two ACT! companies "PQ Twin Test" in the same country (or both with no country). Finalise a quote for a PathQuote "PQ Twin Test". Expect: the quote held, "ACT! has 2 companies that could be …" naming both with city and country; a manager with the ACT! tick sees the sentence and no buttons; an administrator sees both with "Use this company" and "Create a new company in ACT!". Choose one: the quote (and any other quote on that client) goes on within minutes, and ACT! gets no third company. Repeat with a fresh pair and choose "Create a new company in ACT!": exactly one new company appears.
- [ ] **4. An imported contact already associated with a company** — an ACT! test contact associated with a test company, imported into PathQuote (its PathQuote company without an ACT! id). Quote it. Expect: that company used (no lookup by name, no create), its addresses overwritten from PathQuote, the contact **not** relinked. And an imported contact associated with a company of a *different* name than its PathQuote company: the associated company is still used (strongest evidence).
- [ ] **5. A distributor author linked to an Inactive ACT! user** — author linked to Enrico Zamarra (Inactive). Quote a new contact and new company. Expect: contact, company and opportunity owned by Enrico Zamarra; the opportunity visible on the contact's Opportunities tab (not in other users' default Opportunities list — accepted, spec §3.6).
- [ ] **6. An unlinked author** — a distributor with no ACT! user. Expect: contact, company and opportunity owned by John Hollo; `act:show-quote` shows no owner pending anywhere; no `set-owner` step in the drain log.
- [ ] **7. Echo** — after scenarios 1–6, run the inbound sync (Sync now, or wait for 03:00): the contacts touched are **not** counted as updated, and nothing in PathQuote changed for them (owner and link stored their read-back as the baseline).
- [ ] **8. Danam (Q-AU-2026-002)** — at its next event (signature or acceptance): its company found or created and written, Sangeeta Kant associated with it (her contact was created with company text only), the existing opportunity associated with it; her owner unchanged (created before this).
- [ ] **9. A quote with no company** (`Document.companyId` null, if one exists): unchanged behaviour — opportunity and History, no company steps.

If anything goes wrong: switch sending off (stops every write at the next request), `npm run act:show-quote`, and read `docker compose logs app | grep "act:"` and `/var/log/pq-act-drain.log`.
