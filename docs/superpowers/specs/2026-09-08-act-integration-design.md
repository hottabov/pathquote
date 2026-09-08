# ACT! Integration — Design

**Date:** 2026-09-08
**Status:** Approved, ready for implementation planning
**Vendor-facing companion document:** `docs/act-integration-vendor-spec.md`

---

## Problem

Two gaps, one root cause.

Inbound enquiries from pathfindercut.com arrive by email and are manually retyped into ACT!. Nothing is scored, nothing is enriched, and a salesperson cannot tell a serious buyer from a student asking for a brochure without reading every message.

Separately, PathQuote has no client data. A salesperson who has just closed a deal by phone must retype the client into PathQuote before issuing a quote, even though the client already exists in ACT! with a complete address and history.

The root cause is that ACT! Premium Desktop has no programmatic interface. There is no API to call and no supported way to write.

## Goal

ACT! stays the single source of truth for client data. Everything else reads from it or reports back to it.

- Web enquiries land in ACT! already enriched, scored, and routed, with a follow-up task on the right salesperson.
- PathQuote holds a searchable local copy of contacts so a quote can start with three keystrokes.
- Quote activity flows back into ACT! so the CRM shows the full client story.

## Non-goals

- Bidirectional field-level synchronisation. PathQuote creates contacts in ACT! and appends history; it never edits existing ACT! fields. Conflict resolution across two systems is a separate project and we are not starting it.
- Replacing ACT!. PathQuote is a quoting tool with a read cache, not a second CRM.
- Modelling sales pipeline state in PathQuote. Stage, priority, and equipment profile are read and displayed, not managed.

---

## Architecture

```
                    FLOW 1 — one way
  ┌──────────────┐     ┌─────────────────────────────┐
  │ pathfindercut│     │            n8n              │
  │  .com        │────▶│ spam → route → enrich →     │
  │ Gravity Forms│     │ score → history + activity  │
  └──────────────┘     └──────────────┬──────────────┘
                                      │  POST /contacts/upsert
                                      ▼
                         ╔═════════════════════════╗
                         ║          ACT!           ║
                         ║  source of truth        ║
                         ║  17,373 contacts        ║
                         ╚═══╤═════════════════▲═══╝
            SQL delta read   │                 │  history "Quote sent"
            EDITDATE >       │                 │  + opportunity
            modifiedSince    ▼                 │  + contact create
                         ┌─────────────────────┴───┐
                         │       PathQuote         │
                         │  search → quote → PDF   │
                         └─────────────────────────┘
                    FLOW 2 — round trip
```

The two flows meet only inside ACT!. n8n never writes to PathQuote; PathQuote never talks to the website or to n8n.

A consequence worth stating plainly: a lead created by n8n at 10:00 does not appear in PathQuote until the nightly sync. That is precisely why the manual "Load contacts" button exists — a salesperson who closes that lead at 14:00 needs it now.

### Transport decision

ACT! Premium Desktop is licensed here without the web tier, so the built-in Act! Web API does not exist in this installation. Three options were considered:

| Option | Verdict |
|---|---|
| SQL read + custom .NET write service on the Act! SDK | **Chosen.** Works with current licensing, writes go through the supported business layer, sync-safe. |
| Install Act! Premium for Web, use the built-in Act! Web API | Acceptable fallback. Zero custom write code, but needs an APFW licence and an IIS deployment. |
| Direct SQL in both directions | Rejected. Bypasses the business layer, breaks remote-database replication, voids Act! supportability. |

The field contract is identical under the first two, so the vendor specification defines operations and fields, with transport as a separate replaceable section. If the vendor prefers the web tier, nothing in the mapping changes.

---

## Data model changes in PathQuote

### Company

| Column | Type | Purpose |
|---|---|---|
| `actCompanyId` | `String?` `@unique` | ACT! `COMPANYID`. Null for companies that exist only in PathQuote. |
| `actRecordManager` | `String?` | ACT! login of the owning salesperson, kept for display and for routing. |
| `actStatus` | `String?` | ACT! `ID/Status`, promoted out of the snapshot because it drives list filtering. |
| `actSnapshot` | `Json?` | Full last-seen ACT! payload. |
| `actSyncedAt` | `DateTime?` | Timestamp of the sync that produced `actSnapshot`. |

### Contact

| Column | Type | Purpose |
|---|---|---|
| `actContactId` | `String?` `@unique` | ACT! `CONTACTID`. The anchor for the whole integration. |
| `actSyncState` | `enum ActSyncState` | `SYNCED` / `PENDING` / `CONFLICT` |
| `actSyncedAt` | `DateTime?` | |
| `actSnapshot` | `Json?` | |

### Why a JSON snapshot rather than columns

ACT! carries roughly forty fields PathQuote has no model for: `Stage`, `Priority`, `Cutter User`, `CAD User`, `PF Product 1..5`, `Serial 1..5`, `Install Date 1..5`, `Warranty 1..5`, `Referred By`, `Last Reach`, and so on. Giving each a column would mean designing a second CRM schema inside PathQuote, and most of them would never be queried.

The snapshot holds everything verbatim and is enough to render a client's equipment history in the client card. When a concrete feature needs to filter on one of these — "show me every customer with a Gerber cutter" — that field graduates to a real column with a migration. Until then it stays in JSON.

Only `actStatus` is promoted up front, because the contact list filters on it from day one.

### Sync state machine

| State | Meaning | How it is reached |
|---|---|---|
| `SYNCED` | Has `actContactId`, matches the last snapshot | Pulled from ACT!, or pushed to ACT! and acknowledged |
| `PENDING` | Created in PathQuote, push queued | Salesperson created a client the VPN could not reach ACT! to register |
| `CONFLICT` | Locally edited after sync | Salesperson edited a synced contact in PathQuote |

`CONFLICT` shows both versions side by side with a "take ACT! value" action. It does not push. Editing in PathQuote is a local override, and the fix belongs in ACT!.

---

## Pull

One operation, two callers. A nightly cron and the manual button both invoke the same delta read with a `modifiedSince` cursor. There is no separate full-import path after the first run.

**Scopes.** An admin pulls everything public plus everything regardless of record manager. A manager pulls their own records plus public records. This mirrors PathQuote's existing manager-permissions model (`docs/superpowers/specs/2026-09-06-manager-permissions-design.md`).

**Filters, applied on the ACT! side.** `Contact Type = 'Contact'`; not `Private` unless owned by the caller; `ID/Status` in `Customer`, `Prospect`, `Prospect-Distributor`, `Suspect`. Contacts with an empty status are excluded — a business decision, roughly 1,393 records.

**Merge policy is fill-only-empty.** A sync writes into a PathQuote field only when that field is currently null or blank. Anything a salesperson typed is never silently replaced. The full ACT! payload still lands in `actSnapshot`, so a divergence can be shown without destroying either version.

The same rule governs the write direction with one exception: the five `PQ ` fields in ACT! are always refreshed with the latest enquiry's values, because they describe the most recent enquiry rather than a durable property of the contact. Every other ACT! field is fill-only-empty in both directions.

**Country conversion.** ACT! stores full country names (`United States`); PathQuote stores ISO 3166-1 alpha-2 (`US`). The importer converts using `src/lib/countries.ts`. Unmapped values are left null and logged rather than guessed.

**Industry.** ACT! `Industry` is free text with drift (`Composites` and `Composites/Tech Textiles` both exist). It is matched case-insensitively against the existing `Industry` lookup table. No match means no link plus a log line — the importer never creates industries, because that reintroduces exactly the drift the lookup table was built to prevent.

**Company resolution.** When `COMPANYID` is present, it maps one-to-one. When it is null the contact carries only a company name, and companies are grouped by a normalised name: lowercased, legal suffixes stripped, whitespace collapsed.

**Rate limiting.** The manual button is limited to one call per five minutes per user. The ACT! database is slow and this button is the obvious way to hammer it.

---

## Push

A single upsert endpoint on the ACT! side handles creation and update, and decides which of the two applies. Deduplication lives where the data lives; a search-then-write pattern driven from n8n would race on concurrent submissions.

Two callers share the endpoint with separate API keys:

- **n8n**, for qualified inbound enquiries.
- **PathQuote**, when a salesperson creates a client that does not exist in ACT! yet.

The second caller closes the hole the architecture would otherwise have. Without it, a client entered directly into PathQuote — a walk-in, a trade-show contact, someone who emailed a salesperson directly — would live outside the CRM forever, which is the shadow database this project exists to prevent.

It has a useful side effect. The same deduplication ladder that protects n8n protects PathQuote: a salesperson typing a client who already exists in ACT! gets the existing `CONTACTID` back rather than creating a twin, along with a warning naming the current owner. PathQuote becomes a duplicate filter instead of a duplicate source.

**Deduplication ladder:** idempotency key → exact email → E.164 phone → company name plus surname (flag, do not merge) → create.

**Update semantics:** empty ACT! fields only, `Record Manager` never reassigned, history always written.

**Offline behaviour:** if the VPN is down, the contact is created locally as `PENDING`, quoting proceeds unaffected, and a background worker retries. The write-back history for that quote queues behind it.

---

## Where the AI output goes

The scoring model produces an overall score, six sub-scores, a recommendation, and enrichment findings. These land in four places.

| Output | Destination | Reason |
|---|---|---|
| Overall score, 0–10 | New ACT! field `PQ Lead Score` | A salesperson filters and sorts on it |
| Six sub-scores plus narrative plus enrichment findings | History record body | Read, not filtered. Six more columns in the contact layout would be scrolled past daily. |
| Recommended action | Activity, type Call, due today, when score ≥ 8 | The salesperson's actual worklist |
| Qualification signals | Existing fields `Industry`, `Cutter User`, `Interested in`, `Priority` | These fields already exist and already mean this |

`Cutter User` deserves a note. It is populated on 24% of contacts and holds what equipment the client already runs — `Lectra`, `Gerber`, `hand cutting`. That is exactly the enrichment signal the pipeline is meant to discover, and it already has a home. No new field.

### New ACT! fields

Five, all prefixed `PQ `: `PQ Web Entry ID` (indexed, the idempotency key), `PQ Lead Score`, `PQ Enquiry Type`, `PQ Lead Source`, `PQ Landing Page`.

`AMA Score` is empty across all 17,373 records and was briefly attractive as a free slot. It belongs to Act! Marketing Automation, which is inactive rather than absent, and would be reclaimed the moment that module is switched on. The same applies to `AEM Opt Out`, `AEM Bounce Back`, `Bounced`, and `Email 2 Bounced`. New fields are cheaper than that risk.

---

## Write-back

On quote finalisation PathQuote writes a history record — `Quote Q-AU-2026-014 sent`, with total, currency, line items, validity, and PDF link — and creates or updates an opportunity.

Opportunity stage mapping is deliberately unresolved. ACT! opportunities run their own process with their own stage list, and the `Stage` field visible in the contact export is a different entity. The vendor supplies the actual process and stage list, and the mapping is agreed then. Guessing here produces a mapping that fails silently.

Quote line items are sent as free-form product entries and are not linked to the ACT! product catalogue. The authoritative catalogue lives in PathQuote; a second copy inside ACT! would be a second source of truth for pricing.

---

## Risks

**Remote databases.** Whether synchronised remote ACT! databases exist is unconfirmed. If they do, it hard-rules-out any direct-SQL write shortcut the vendor might propose under time pressure. This is the first blocking question in the vendor document.

**Slow database.** Every read is a keyset-paginated delta on an indexed `EDITDATE`. No offset pagination, no `SELECT *` across 147 columns, no full scans in steady state.

**Missing contact ids.** The export we hold has no `CONTACTID`. If the vendor cannot expose it, the whole integration degrades to a one-off import matched on email, which covers only 79% of contacts. This is the single hardest requirement in the specification.

**Vendor capability.** Option A needs C# against the Act! SDK. If that is beyond the vendor, Option B is the fallback, at the cost of an APFW licence. The field contract survives either way.

**Scope creep toward two-way sync.** The moment PathQuote edits propagate back to ACT!, this becomes a distributed-systems problem. The rule that keeps it small: PathQuote creates and appends, never edits.

---

## Decomposition

This document covers the ACT! interface contract only. Two further specs follow, each independently plannable:

1. **n8n lead pipeline** — spam filtering, enquiry-type routing, enrichment sources, the scoring prompt and its rubric, cost controls, retry and dead-letter handling.
2. **PathQuote import and client UI** — sync worker, the "Load contacts" button, contact search, the divergence view, and the `PENDING` / `CONFLICT` states in the interface.

The vendor work in `docs/act-integration-vendor-spec.md` is on the critical path for both.

---

## Open items

| Item | Owner | Blocks |
|---|---|---|
| Do synchronised remote ACT! databases exist? | ACT! vendor | Transport choice |
| Opportunity process and stage list | ACT! vendor | Write-back stage mapping |
| ACT! user list with logins and emails | ACT! vendor | ACT! user → PathQuote user mapping |
| Territory → Record Manager routing table | Pathfinder sales | Lead assignment on create |
| Is the ACT! Company entity actually used? | ACT! vendor | Whether `GetCompanies` stays in scope |
