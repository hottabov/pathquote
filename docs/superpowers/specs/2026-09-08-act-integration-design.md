# ACT! Integration — Design

**Date:** 2026-09-08 (revised 2026-09-09)
**Status:** Approved, ready for implementation planning
**Vendor-facing companion:** `docs/act-integration-vendor-spec.md` — a bare field list. All reasoning lives here; the vendor was explicit that he wants the mapping and nothing else.

---

## Problem

Inbound enquiries from pathfindercut.com arrive by email and are retyped into ACT! by hand. Nothing is scored or enriched, and a salesperson cannot tell a buyer from a student without reading every message.

Separately, PathQuote has no client data. A salesperson who has closed a deal by phone retypes the client before issuing a quote, even though the client already exists in ACT! with a full address.

The root cause is that ACT! Premium Desktop has no programmatic interface here. There is no API to call and no supported way to write.

## Goal

ACT! is the system of record for client data. Everything else reads from it or reports back to it.

- Web enquiries land in ACT! enriched, scored, routed, with a follow-up task on the right salesperson.
- PathQuote holds a searchable local copy so a quote starts with three keystrokes.
- Quote activity flows back so the CRM shows the whole client story.
- PathQuote is a good enough place to enter client data that salespeople will actually use it.

## Non-goals

- Automatic field-level merge. Conflicts are refused and shown to a person, never resolved by the system.
- Replacing ACT!. PathQuote edits client identity and addresses — what a quote needs. Pipeline, history, and activities stay read-only.
- Modelling sales pipeline state in PathQuote.

---

## Architecture

```
                    FLOW 1 — one way
  ┌──────────────┐     ┌─────────────────────────────┐
  │ pathfindercut│     │            n8n              │
  │  .com        │────▶│ spam → route → enrich →     │
  │ Gravity Forms│     │ score → history + activity  │
  └──────────────┘     └──────────────┬──────────────┘
                                      │  upsert
                                      ▼
                         ╔═════════════════════════╗
                         ║          ACT!           ║
                         ║  system of record       ║
                         ║  17,373 contacts        ║
                         ║  126 companies          ║
                         ╚═══╤═════════════════▲═══╝
            delta read       │                 │  create · fill · edit
            EDITDATE >       │                 │  history · opportunity
            modifiedSince    ▼                 │
                         ┌─────────────────────┴───┐
                         │       PathQuote         │
                         │  search → quote → PDF   │
                         └─────────────────────────┘
                    FLOW 2 — round trip
```

The two flows meet only inside ACT!. n8n never writes to PathQuote; PathQuote never talks to the website or to n8n.

A lead created by n8n at 10:00 does not reach PathQuote until the nightly sync — which is why the manual "Load contacts" button exists.

### Transport

ACT! Premium Desktop is licensed here without the web tier, so the built-in Act! Web API does not exist in this installation. The vendor chooses the mechanism; the field contract is the same either way. Direct SQL writes are the one option we will not accept: they bypass the ACT! business layer, are not enqueued for remote-database replication, and void supportability. Whether remote databases exist is an open question to the vendor, and it decides how severe that is.

---

## Entity ownership

Both ACT! entities carry overlapping data. The split is fixed:

| Entity | Owns |
|---|---|
| Company | name, main address, billing address, shipping address, website, industry, territory |
| Contact | first name, surname, position, email, phone |

Consequence: ACT! Company `Phone`, `Toll-Free Phone`, and `Fax Phone` are not read at all. A quote takes its addresses from the company and its human details from the contact.

This resolved the delivery-address question. ACT! Contact has no shipping block, but ACT! Company has stock `Billing *` and `Shipping *` field groups — seven fields each, `Shipping` empty in all 126 companies, `Billing` populated in one. No new address fields are needed.

### The 126-company problem

There are 126 company records against 17,373 contacts. The Company entity is effectively unused; almost every contact carries a company name as free text and is linked to nothing.

So billing and shipping addresses barely exist today. Rather than a migration nobody will run, the Company entity grows from real work: **when a salesperson first prepares a quote and learns the delivery address, PathQuote creates or fills the ACT! Company record.** In a year there will be exactly as many companies as there have been deals.

Contacts with no `COMPANYID` are grouped into PathQuote companies by normalised name — lowercased, legal suffixes stripped (`Ltd`, `Pty Ltd`, `GmbH`, `Inc`, `LLC`, `BV`, `SA`, `AB`, `Oy`), whitespace collapsed, punctuation removed.

### Address mapping

ACT! Company has three addresses, PathQuote has two. PathQuote's main address is the billing/office address (see the schema comment on `Company.deliverySameAsMain`), and `delivery*` is the manufacturing site.

| PathQuote | Source |
|---|---|
| `street`, `city`, `state`, `postcode`, `country` | `Billing *` when populated, otherwise `Address 1..3` + `City`/`State`/`Postcode`/`Country` |
| `delivery*` | `Shipping *` |
| `deliverySameAsMain` | derived — `true` when the `Shipping *` block is empty |

`Country` in the company export is dirty (`USA` and `United States` both occur). Normalise before converting to ISO 3166-1 alpha-2 via `src/lib/countries.ts`.

---

## Data model changes in PathQuote

### Company

| Column | Type | Purpose |
|---|---|---|
| `actCompanyId` | `String?` `@unique` | ACT! `COMPANYID` |
| `actRecordManager` | `String?` | Owning salesperson's ACT! login |
| `actStatus` | `String?` | ACT! `ID/Status`, promoted out of the snapshot because it drives list filtering |
| `actEditDateAtSync` | `DateTime?` | Concurrency token — the `EDITDATE` seen at last sync |
| `actSnapshot` | `Json?` | Last-seen ACT! payload |
| `actSyncedAt` | `DateTime?` | |

### Contact

| Column | Type | Purpose |
|---|---|---|
| `actContactId` | `String?` `@unique` | ACT! `CONTACTID` |
| `actSyncState` | `enum ActSyncState` | `SYNCED` / `PENDING` / `CONFLICT` |
| `actEditDateAtSync` | `DateTime?` | Concurrency token |
| `actSnapshot` | `Json?` | |
| `actSyncedAt` | `DateTime?` | |

### Sync state machine

| State | Meaning |
|---|---|
| `SYNCED` | Has an ACT! id and matches the last snapshot |
| `PENDING` | Created or edited locally, write queued — the VPN was unreachable or the write has not run yet |
| `CONFLICT` | Either the snapshot diverged after a sync, or a write was refused because ACT! changed first |

`CONFLICT` shows both versions side by side and a person chooses. Nothing merges automatically.

---

## Pull

One operation, two callers: a nightly cron and the manual button, both passing a `modifiedSince` cursor. There is no separate full-import path after the first run.

**Scopes.** An admin pulls everything non-private. A manager pulls their own records plus public records. Mirrors the existing manager-permissions model (`2026-09-06-manager-permissions-design.md`).

**Filters, applied on the ACT! side.** `Contact Type = 'Contact'`; not `Private` unless owned by the caller; `ID/Status` in `Customer`, `Prospect`, `Prospect-Distributor`, `Suspect`. Contacts with an empty status are excluded — a business decision, about 1,393 records. The filtered set is 12,094 contacts.

**Merge policy is fill-only-empty.** A sync writes into a PathQuote field only when that field is null or blank. What a salesperson typed is never silently replaced. The full ACT! payload lands in `actSnapshot`, so a divergence can be shown without destroying either version.

**Rate limiting.** The manual button is one call per five minutes per user. The ACT! database is slow and this button is the obvious way to hammer it.

### Fields deliberately not pulled

The first draft of this design asked for roughly sixty contact fields. Most had nowhere to go: PathQuote's `Contact` has six columns and `Company` has about twenty. Everything else would have landed in `actSnapshot` and been read by nobody.

Cut: `Salutation`, `Contact`, `Middle Name`, `Name Prefix/Suffix` (duplicate first/last name) · `E-Mail 2`, `Phone 2`, `Alt Phone`, `Fax`, `Phone Ext-` (PathQuote has one email and one phone, deliberately) · `Address 3`, `Website 2`, `Department` · `Account Mgr`, `Record Creator`, `Last Edited By`, `Owner` (one owner, `Record Manager`) · `Stage`, `Priority`, `Referred By` (pipeline, not managed here) · `Last Reach`, `Last Attempt`, `Last Meeting`, `Last E-mail`, `Last Results` (activity, not displayed) · `CAD User`, `CAD 2/3`, `Cutter 2..5`, `Install Date 1..5`, `Warranty 1..5`, `PF Product 1..5`, `Serial 1..5` (equipment profile — no PathQuote screen shows it, and parts enquiries go to support, not sales).

`Cutter User` is still **written** by the enrichment pipeline even though it is not read. ACT! gets richer; PathQuote just does not use it. The vendor document flags this so it does not look like a mistake.

`PQ Lead Score` and `PQ Lead Source` are also not pulled — PathQuote has no column for them. Marketing reporting reads them from ACT! directly.

### Phone normalisation

PathQuote stores E.164. ACT! stores whatever twenty years of typing produced: `03 94679176`, `0419 373 626`, `(317) 271-1207`, `0 1621 840 077`.

`google-libphonenumber` handles all of these — but only when told which country to assume. The same string fails without a region:

| Input | Region | Result |
|---|---|---|
| `03 94679176` | AU | `+61394679176` |
| `03 94679176` | — | fails |
| `770 928 3915` | US | `+17709283915` |
| `770 928 3915` | — | fails |

The region comes from the contact's own `Country` field, per row — not a global default. `src/lib/phone.ts` already takes `defaultRegion`; `src/lib/countries.ts` already maps names to ISO-2.

The ladder, in order:

1. Number begins with `+` → parse as-is.
2. Contact's `Country` maps to ISO-2 → parse with that region.
3. Otherwise leave `Contact.phone` null, keep the raw string in the snapshot, flag the contact.

`Mobile Phone` is read only as a fallback when `Phone` is empty; it is never written. Without it, 874 active contacts would arrive with no number at all.

Measured over the 12,094 active contacts:

| Outcome | Contacts | |
|---|---|---|
| Parsed to E.164 | 10,740 | 88.8% |
| Junk — fewer than five digits, stray `\r`, blank | 412 | 3.4% |
| Has digits, will not parse with its stated country | 942 | 7.8% |

The third row is mostly a wrong country, not a broken number: `061 0759 9550` on a contact whose country says United States is an Australian number.

**Recovery rules beyond step 2 were tested and rejected.** Treating a failed number as an international one that lost its `+` recovers 102 contacts, 0.8% — and gets some of them wrong: `060 5286 3604` on a US contact becomes `+60…`, which is Malaysia. A plausible-looking wrong number on a signed quote is worse than a blank field, so the ladder stops at step 2.

A useful side effect: PathQuote becomes a data-quality indicator for ACT!. Those 942 contacts are a list nobody can see today. A salesperson opens the card, sees "phone not recognised", and fixes it in ACT!.

Bulk normalisation of the 10,740 parsed numbers back into ACT! is deliberately out of scope for v1. It is a one-off job with a dry run and a reviewed diff, worth doing once the write channel has been proven.

### Industry resolution

Already solved in this repository, and better than the first draft of this design assumed.

`scripts/data/act-industries.json` holds 31 canonical segments and 352 aliases; `resolveActIndustry()` in `scripts/import-act-industries.ts` is exported specifically for this import. Checked against the company export: 17 distinct spellings, all covered.

The importer must:

- resolve through `resolveActIndustry()`, not by case-insensitive name matching
- leave `industryId` null when no alias matches, and still import the contact
- **never create an industry row** — that is what produced 335 spellings in the first place
- write unmatched values to a report for periodic review and addition to the JSON

---

## Push

PathQuote writes to ACT!. This was the largest design change: the earlier rule was "creates but never edits", and it broke on the first real scenario — a salesperson learns the delivery address while sitting in PathQuote, and telling them to go and type it into ACT! guarantees it lives only in PathQuote.

The reasoning for allowing edits: the dangerous operation is not writing, it is *silently overwriting*. That is solvable without automatic merge.

### Four guardrails

**Whitelist.** The write endpoints accept only the fields PathQuote displays and edits — roughly twenty. `Record Manager`, `ID/Status`, `Stage`, `Priority`, `Referred By`, and every marketing-automation field are unwritable by construction, not by agreement.

**Optimistic concurrency.** PathQuote stores the `EDITDATE` seen at last sync and sends it with every edit. If it no longer matches, the write is refused and current values are returned. The salesperson sees both versions and chooses. No update is ever lost silently.

**No deletes.** No delete endpoint exists. A wrong record is removed in ACT! by hand.

**History trail.** Every write from PathQuote leaves a history record naming the person, the time, and what changed. Nothing changes invisibly and anything can be rolled back by reading the history.

The rule becomes: **PathQuote creates, fills what is empty, and edits whitelisted fields under optimistic locking. It never deletes and never overwrites blindly.**

### Deduplication

Evaluated in order, first match wins. Handled on the ACT! side in one operation, so two concurrent submissions cannot race into duplicates.

| Step | Rule | Action |
|---|---|---|
| 0 | `PQ Web Entry ID` already present | return the existing id, write nothing |
| 1 | exact case-insensitive `E-mail` match among `Contact Type = 'Contact'` | update |
| 2 | exact E.164 phone match | update |
| 3 | normalised company name and surname match | create, flag the possible duplicate in history, raise a review activity |
| 4 | no match | create |

The same ladder protects contacts a salesperson types into PathQuote: an existing client returns their existing `CONTACTID` and a warning naming the current owner, so PathQuote filters duplicates rather than producing them.

### Strategic consequence

If entering a client is easier in PathQuote, salespeople will do it in PathQuote — always, not sometimes. PathQuote becomes the de facto entry interface and ACT! becomes storage and reporting.

Two things follow. Data quality in ACT! now depends on PathQuote's screens, so validation, required fields, duplicate warnings, and country and phone normalisation have to be good — that is scope on our side, not the vendor's. And there will be pressure to add the rest of the CRM to PathQuote: a note, then call history, then a task. The boundary that prevents a second CRM is the whitelist, which is enforced in the endpoint rather than written in a document.

---

## Lead routing

The website form offers five enquiry types. Only two reach ACT!.

| Enquiry type | Destination |
|---|---|
| `General` | full sales pipeline: enrichment, scoring, ACT! |
| `Machinery Sales/Technical Specifications` | full sales pipeline |
| `Technical Support` | support inbox, ACT! untouched |
| `Parts & Consumable Orders` | support inbox, ACT! untouched |
| `Accounts` | accounts inbox, ACT! untouched |

`General` goes through the pipeline because it is the default choice and half the volume — 14 of 28 submissions over 30 days. Routing on the dropdown alone would discard half the real leads. Scoring is what separates a buyer from a student: a lead scoring 2 creates no activity and disturbs nobody, and AI on that volume is trivially cheap against one lost machine.

Because support and parts never reach ACT!, the `Machine Model` and `Serial Number` form fields are out of the push mapping entirely.

The `Region` field has six values, not the four visible in the export: `USA` and `Canada` → North America, `Europe` and `United Kingdom` → Europe, `Australia` → Australia, `Other` → empty plus a review flag.

---

## Where the AI output goes

| Output | Destination |
|---|---|
| Overall score, 0–10 | `PQ Lead Score` — filterable and sortable |
| Six sub-scores, narrative, enrichment findings | history record body |
| Recommended action | activity, type Call, due today, when score ≥ 8 |
| Qualification signals | existing fields `Industry`, `Cutter User`, `Interested in`, `Priority` |

The six sub-scores get no fields. Nobody filters on them, and six extra columns in the contact layout would be scrolled past daily.

`Cutter User` holds what equipment the client already runs — `Lectra`, `Gerber`, `hand cutting` — populated on 24% of contacts. That is exactly the enrichment signal the pipeline discovers, and it already has a home.

### New ACT! fields

Five, all prefixed `PQ `: `PQ Web Entry ID` (indexed, the idempotency key), `PQ Lead Score`, `PQ Enquiry Type`, `PQ Lead Source`, `PQ Landing Page`.

`AMA Score` is empty across all 17,373 records and was briefly attractive as a free slot. It belongs to Act! Marketing Automation, which is inactive rather than absent, and would be reclaimed the moment that module is switched on. Same for `AEM Opt Out`, `AEM Bounce Back`, `Bounced`, `Email 2 Bounced`.

---

## The `[AUTO]` marker

Every automatic history record must be distinguishable from one a person wrote — a dedicated history type, or a `Regarding` line that always begins with `[AUTO]`.

Without it, every lead has a history record from its first second, written by the robot. The question "which leads has nobody worked?" then returns nothing, forever, and "time to first human contact" is measured against a machine.

This has to be in place from the first record written. Six months of history in which the robot is indistinguishable from a salesperson cannot be repaired.

---

## Write-back

On quote finalisation PathQuote writes a history record — `Quote Q-AU-2026-014 sent`, with total, currency, line items, validity, PDF link — and creates or updates an opportunity.

Opportunity stage mapping is deliberately unresolved. ACT! opportunities run their own process with their own stage list, and the `Stage` field on the contact is a different entity. The vendor supplies the real list and the mapping is agreed then; guessing produces a mapping that fails silently.

Quote line items go across as free-form product entries, not linked to the ACT! product catalogue. The authoritative catalogue lives in PathQuote, and a second copy in ACT! would be a second source of truth for pricing.

---

## Reporting

Marketing and management reporting queries **ACT!, not PathQuote.**

PathQuote holds a deliberately narrowed copy: active statuses only, sales-relevant fields only, fill-only-empty merge. Leads scored 2 and filtered out, `Accounts` enquiries, and locally edited contacts are all absent or different. Reports built on it would produce numbers that look right and are not, with no visible signal that they are wrong.

Two read-only operations cover what is wanted, over the same channel and the same login:

| Operation | Returns |
|---|---|
| Activity summary, per period | manager, activity type, count — for the Monday team digest |
| Lead response metrics, per period | one row per contact created: id, company, create date, record manager, territory, lead source, lead score, enquiry type, first human touch date and type, human touch count |

From the second, `GROUP BY` answers everything asked so far: volume by week and source and region, share touched within 24 or 48 hours or never, median time to first touch by manager, and eventually whether the AI score correlates with what salespeople actually pursue — the measurement that says whether the scoring is worth paying for.

Both need the history-type list from the vendor to know what counts as a human touch, and both depend on logging discipline: a manager who calls and records nothing looks identical to one who ignored the lead. That distorts response metrics; it does not affect lead-volume metrics, which count leads rather than reactions.

These are not in the vendor document — he asked for the field mapping only — but they are worth requesting verbally in the same engagement. A third read procedure while he is already in the read layer costs hours; the same request in six months is a fresh negotiation.

---

## Risks

**Remote databases.** Unconfirmed. If they exist, no direct-SQL write shortcut is acceptable under any time pressure.

**Slow database.** Keyset-paginated deltas on an indexed `EDITDATE`. No offset pagination, no `SELECT *` across 147 columns, no full scans in steady state.

**Missing contact ids.** No export we hold contains `CONTACTID`. Without it the integration degrades to a one-off import matched on email, which covers 79% of contacts. This is the hardest requirement in the vendor document.

**Scope creep toward a second CRM.** Contained by the write whitelist, which is code rather than policy.

---

## Decomposition

This document covers the ACT! interface contract. Two further specs follow:

1. **n8n lead pipeline** — spam filtering, routing, enrichment sources, the scoring rubric, cost controls, retry and dead-letter handling.
2. **PathQuote sync and client UI** — sync worker, the "Load contacts" button, search, the conflict view, and the `PENDING` / `CONFLICT` states in the interface.

The vendor work is on the critical path for both.

---

## Open items

| Item | Owner | Blocks |
|---|---|---|
| Do synchronised remote ACT! databases exist? | ACT! vendor | Transport choice |
| Opportunity process and stage list | ACT! vendor | Write-back stage mapping |
| History type list | ACT! vendor | `[AUTO]` marker method, reporting |
| ACT! user list with logins and emails | ACT! vendor | ACT! user → PathQuote user mapping |
| Territory → Record Manager routing table | Pathfinder sales | Lead assignment on create |
