# ACT! Integration — Design

**Date:** 2026-09-08 · revised 2026-10-05
**Status:** Approved, ready for implementation planning
**API reference:** `docs/act-integration-reference.md` — field mappings, endpoints, infrastructure, all verified against the live system

---

## Problem

Inbound enquiries from pathfindercut.com arrive by email and are retyped into ACT! by hand. Nothing is scored or enriched, and a salesperson cannot tell a buyer from a student without reading every message.

Separately, PathQuote has no client data. A salesperson who has closed a deal by phone retypes the client before issuing a quote, even though the client already exists in ACT! with a full address.

## Goal

ACT! is the system of record for client data. Everything else reads from it or reports back to it.

- Web enquiries land in ACT! enriched, scored, routed, with a follow-up task on the right salesperson.
- PathQuote holds a searchable local copy so a quote starts with three keystrokes.
- Quote activity flows back so the CRM shows the whole client story.
- PathQuote is a good enough place to enter client data that salespeople will actually use it.

## Non-goals

- Automatic field-level merge. Conflicts are refused and shown to a person, never resolved by the system.
- Replacing ACT!. PathQuote edits client identity and addresses — what a quote needs. Pipeline, history and activities stay read-only.
- Modelling sales pipeline state in PathQuote.

---

## Architecture

```
                    FLOW 1 — one way
  ┌──────────────┐     ┌─────────────────────────────┐
  │ pathfindercut│     │            n8n              │
  │  .com        │────▶│ spam → route → enrich →     │
  │ Gravity Forms│     │ score → note + activity     │
  └──────────────┘     └──────────────┬──────────────┘
                                      │  Act! Web API
                                      ▼
                         ╔═════════════════════════╗
                         ║          ACT!           ║
                         ║  system of record       ║
                         ║  17,373 contacts        ║
                         ║  126 companies          ║
                         ╚═══╤═════════════════▲═══╝
            delta read       │                 │  create · fill · edit
            $filter=         │                 │  history · opportunity
            edited gt …      ▼                 │
                         ┌─────────────────────┴───┐
                         │       PathQuote         │
                         │  search → quote → PDF   │
                         └─────────────────────────┘
                    FLOW 2 — round trip
```

Both flows meet only inside ACT!. n8n never writes to PathQuote; PathQuote never talks to the website or to n8n.

A lead created by n8n at 10:00 does not reach PathQuote until the nightly sync — which is why the manual "Load contacts" button exists.

### Transport: the Act! Web API, already installed

The project was scoped on the understanding that Act! Premium Desktop here had no web tier, which would have meant either a custom .NET service on the Act! SDK or a direct-SQL path with the risks that carries. Both are moot: **Act! Premium for Web and the Act! Web API v1.1.524.0 are installed and serving the production database.** Nobody was using them.

What that removes: no C# service, no SQL login, no reverse-engineering of the schema, and no third-party developer. What remains is configuration and our own client code.

Direct SQL writes stay excluded on principle — the database is a sync publisher with managers' laptops subscribed to it, and writes outside the business layer never reach them. The API is the only write path.

`act.webhook.notifications` is installed too, so ACT! can push change events rather than being polled. Not used in v1; it would turn the nightly sync into a near-real-time one later.

---

## Entity ownership

The first version of this design assumed the ACT! Company record was the source
of client addresses. Measuring the data killed that assumption.

| | |
|---|---|
| Active contacts | 12 094 |
| Carrying a company name as free text | 12 088 — **100%** |
| Distinct names after normalisation | 9 622 |
| Names with exactly **one** contact | 8 259 — **85.8%** |
| Names with five or more | 121 |
| ACT! Company records | 125 |
| Names matching a Company record | **103 of 9 622**, covering 307 contacts — **2.5%** |

And on those 125 company records: 93 have a main address, **one** has a billing
address, and **none has a shipping address**. Company `idStatus` is 59 blanks,
and one record's status is the string `John Hollo-`.

The address data lives on the contact: street 93.6%, city 95.6%, email 85.1%.

So the Company entity in ACT! is not a source of truth, it is an artefact. The
design inverts accordingly.

### Company is derived, not imported

PathQuote groups contacts into companies by **normalised name plus country**,
and seeds the company address from the contact's own `businessAddress`.

Country is part of the key because 119 names (1.24%, 470 contacts) appear in
more than one country. Some of that is dirt — `USA` against `United States`,
which normalising the country to ISO-2 resolves — but `adient` genuinely has
offices in five countries and `adidas` in two. A quote to Mexico and a quote to
Romania are different addresses and different terms, so they must not collapse
into one company.

Normalisation: lowercase, strip punctuation, strip legal suffixes (`Ltd`,
`Pty Ltd`, `GmbH`, `Inc`, `LLC`, `BV`, `SA`, `AB`, `Oy`, `Corp`, `Group`,
`Holdings`, `International`), collapse whitespace. On the current data this
merges 273 of 9 895 raw spellings.

Where a contact does carry a `companyID` — the 2.5% — the ACT! Company record
wins, and `Company.actCompanyId` is set. Everywhere else it stays null.

### Addresses

| PathQuote | Source |
|---|---|
| `street`, `city`, `state`, `postcode`, `country` | the contact's `businessAddress`; `billingAddress` of the linked ACT! Company when one exists |
| `delivery*` | `shippingAddress` of the linked ACT! Company — empty for everyone today |
| `deliverySameAsMain` | derived: `true` while the delivery block is empty |

Delivery addresses therefore do not arrive from ACT!. They are captured in
PathQuote at quote time, which is the first moment anyone has a verified one.

### Search is contact-first

With 85.8% of companies holding a single contact, "find the company" and "find
the person" are the same operation. Making a salesperson pick a company before
a contact adds a step that decides nothing in six cases out of seven.

One search box over first name, surname, company text, email and phone,
returning contacts with their company and city:

```
Sarah Harkin · Integral-T · Melbourne, AU
Geoff Smith  · GSE Solutions · Sydney, AU
```

This also matches how the business actually works: the director and the
salespeople look for people, not for companies.

### Clusters

Eleven ACT! companies are flagged as having divisions, all at hierarchy level 0
— the divisions themselves are not in the export. Too few to design around now.
`Company.parentId` exists in the model and stays null until there is a real
case.

When a salesperson types a company name, PathQuote shows every near match with
its city, country and contact count, and offers three answers: this is it, this
is a different company with the same name, this is a division of that one. The
third is how a cluster gets recorded — by the person who knows, not by the
normaliser guessing.

### How this repairs ACT!

Not by instruction. A quote cannot be issued without a confirmed legal name and
a delivery address, so that is the moment the data becomes real — and the moment
PathQuote creates or fills the ACT! Company record and links the contact to it.

In a year ACT! holds as many good company records as there have been deals.
Bulk-creating 9 622 companies would turn a sparse mess into a large one, and
nobody would ever open 95% of them.


## Data model changes in PathQuote

### Company

| Column | Type | Purpose |
|---|---|---|
| `actCompanyId` | `String?` `@unique` | ACT! company `id` |
| `actRecordManagerId` | `String?` | ACT! `recordManagerID` (uuid, stable) |
| `actStatus` | `String?` | ACT! `idStatus`, promoted out of the snapshot because it drives list filtering |
| `actEditedAtSync` | `DateTime?` | Concurrency token — `edited` as seen at last sync |
| `actSnapshot` | `Json?` | Last-seen ACT! payload |
| `actSyncedAt` | `DateTime?` | |

### Contact

| Column | Type | Purpose |
|---|---|---|
| `actContactId` | `String?` `@unique` | ACT! contact `id` |
| `actSyncState` | `enum ActSyncState` | `SYNCED` / `PENDING` / `CONFLICT` |
| `actEditedAtSync` | `DateTime?` | Concurrency token |
| `actSnapshot` | `Json?` | |
| `actSyncedAt` | `DateTime?` | |

### Sync state machine

| State | Meaning |
|---|---|
| `SYNCED` | Has an ACT! id and matches the last snapshot |
| `PENDING` | Created or edited locally, write queued — the overlay was unreachable or the write has not run yet |
| `CONFLICT` | Either the snapshot diverged after a sync, or a write was refused because ACT! changed first |

`CONFLICT` shows both versions side by side and a person chooses. Nothing merges automatically.

---

## Pull

One operation, two callers: a nightly cron and the manual button, both passing an `edited gt <cursor>` filter. There is no separate full-import path after the first run.

**Scope.** One pull, everything non-private, under the service account's `Access All Non-Private Data`. Visibility is decided inside PathQuote, not by fetching different subsets per user — see below.

**Filters.** `contactType eq 'Contact'`; not `isPrivate`; `idStatus` in `Customer`, `Prospect`, `Prospect-Distributor`, `Suspect`. Contacts with an empty status are excluded — a business decision, about 1,393 records. The filtered set is 12,094 contacts.

**`Personal` contacts never leave ACT!.** They are the director's own, and he does not share them. The status filter already excludes them, but that is one condition in one query: the importer also drops any record whose `idStatus` is `Personal`, whatever the API returned. The redundancy is deliberate. If someone later widens the status list and forgets this case, the second barrier holds.

**Field metadata is read at the start of every sync, never cached between runs.** A contact-level `shipping_adress` field appeared in the database two days after the metadata snapshot was taken for this design — the director added it while rebuilding a layout. A snapshot of the schema is a photograph of a moving thing.

**Merge policy is fill-only-empty.** A sync writes into a PathQuote field only when that field is null or blank. What a salesperson typed is never silently replaced. The full ACT! payload lands in `actSnapshot`, so a divergence can be shown without destroying either version.

**Rate limiting.** The manual button is one call per five minutes per user.

### Who sees what

ACT! has no permission model. What a manager sees is a side effect of
replication: a Sync Set lists criteria, and matching contacts are copied to
their laptop. Twelve such sets exist, maintained by hand in a wizard.

They all have the same shape. Brandon's reads:

```
ID/Status != Personal
AND (Country = United States OR Canada OR Mexico)
OR  Account Mgr = Brandon Clark
```

Only two things vary: a list of countries, and the manager's name in
`Account Mgr` — which is `customFields/rep`, populated on 97% of contacts.
Note that visibility runs on **Account Mgr**, not on Record Manager.

Copying twelve rule sets into PathQuote would put the policy in two places,
and the one in ACT! is edited in a GUI by someone who will not think to update
ours. They would drift, and the failure is silent: somebody sees a contact they
should not, or stops seeing one they should.

So PathQuote expresses the same policy once, parameterised per user:

| Field on `User` | Example |
|---|---|
| `actAccountMgr` | `Brandon Clark` |
| `visibleCountries` | `["United States", "Canada", "Mexico"]` |

A manager sees a contact when `customFields/rep` matches them, or the contact's
country is in their list. Admin and developer see everything. Twelve rows of
configuration instead of twelve implementations of the same idea, and a change
to a Sync Set is a change to a list of countries.

**The cost, stated plainly.** Today Brandon's laptop physically holds only
Brandon's contacts; if it is stolen the rest of the database is not on it. In
PathQuote all 12 094 sit in one database behind application-level checks, so a
bug in the filter or a compromised admin account exposes everything. That
property is being given up knowingly. It was never a security design in ACT! —
it is what replication happens to do — and twelve laptops carrying copies of a
CRM is its own larger risk.

**None of this is built yet.** PathQuote has one user and that user is an
admin, so the two fields and the filter are deferred. What the sync must do now
is *keep the inputs*: `customFields/rep` and the contact's country are imported
and stored from day one, so switching visibility on later is a filter and a
migration, not a re-import.

### Fields deliberately not pulled

PathQuote's `Contact` has six columns and `Company` about twenty. Pulling ACT!'s full surface would land most of it in `actSnapshot` to be read by nobody.

Cut: `salutation`, `fullName`, `middleName`, `namePrefix`, `nameSuffix` (duplicate first/last name) · `customFields/email_2_email`, `customFields/phone_2_phone`, `alternatePhone`, `faxPhone` (PathQuote has one email and one phone, deliberately) · `address/line3`, `customFields/website_2`, `department` · `recordOwner`, `editedBy`, `customFields/owner` (one owner, `recordManager`; `customFields/rep` **is** kept — visibility depends on it) · `messengerID` (Stage), `customFields/priority`, `referredBy` (pipeline, not managed here) · `lastReach`, `lastAttempt`, `lastMeeting`, `lastEmail`, `lastResults` (activity, not displayed) · the whole equipment profile — `customFields/user2` (Cutter User), `cutter_2..5`, `cad_2/3`, `pf_product_1..5`, `serial_1..5`, `intall_date_1`, `install_date_2..5`, `warranty_1..5`.

`customFields/user2` (Cutter User) is still **written** by the enrichment pipeline even though it is not read. ACT! gets richer; PathQuote just does not use it.

`PQ Lead Score` and `PQ Lead Source` are not pulled either — PathQuote has no column for them, and marketing reporting reads them from ACT! directly.

### Phone normalisation

PathQuote stores E.164. ACT! stores whatever twenty years of typing produced: `03 94679176`, `0419 373 626`, `(317) 271-1207`, `0 1621 840 077`.

`google-libphonenumber` handles all of these — but only when told which country to assume. The same string fails without a region:

| Input | Region | Result |
|---|---|---|
| `03 94679176` | AU | `+61394679176` |
| `03 94679176` | — | fails |
| `770 928 3915` | US | `+17709283915` |
| `770 928 3915` | — | fails |

The region comes from the contact's own `businessAddress/country`, per row — not a global default. `src/lib/phone.ts` already takes `defaultRegion`; `src/lib/countries.ts` already maps names to ISO-2.

The ladder, in order:

1. Number begins with `+` → parse as-is.
2. Contact's country maps to ISO-2 → parse with that region.
3. Otherwise leave `Contact.phone` null, keep the raw string in the snapshot, flag the contact.

`mobilePhone` is read only as a fallback when `businessPhone` is empty; it is never written. Without it, 874 active contacts would arrive with no number at all.

Measured over the 12,094 active contacts:

| Outcome | Contacts | |
|---|---|---|
| Parsed to E.164 | 10,740 | 88.8% |
| Junk — fewer than five digits, stray `\r`, blank | 412 | 3.4% |
| Has digits, will not parse with its stated country | 942 | 7.8% |

The third row is mostly a wrong country, not a broken number: `061 0759 9550` on a contact whose country says United States is an Australian number.

**Recovery rules beyond step 2 were tested and rejected.** Treating a failed number as an international one that lost its `+` recovers 102 contacts, 0.8% — and gets some of them wrong: `060 5286 3604` on a US contact becomes `+60…`, which is Malaysia. A plausible-looking wrong number on a signed quote is worse than a blank field, so the ladder stops at step 2.

A useful side effect: PathQuote becomes a data-quality indicator for ACT!. Those 942 contacts are a list nobody can see today. A salesperson opens the card, sees "phone not recognised", and fixes it in ACT!.

Bulk normalisation of the 10,740 parsed numbers back into ACT! is out of scope for v1 — a one-off job with a dry run and a reviewed diff, worth doing once the write channel has been proven.

### Industry resolution

Already solved in this repository. `scripts/data/act-industries.json` holds 31 canonical segments and 352 aliases; `resolveActIndustry()` in `scripts/import-act-industries.ts` is exported specifically for this import. Checked against the company export: 17 distinct spellings, all covered.

In ACT! the contact-level field is `customFields/user6`, backed by the `Industry` picklist; the company-level field is `industry`, same picklist.

The importer must:

- resolve through `resolveActIndustry()`, not by case-insensitive name matching
- leave `industryId` null when no alias matches, and still import the contact
- **never create an industry row** — that is what produced 335 spellings in the first place
- write unmatched values to a report for periodic review and addition to the JSON

---

## Push

PathQuote writes to ACT!. The earlier rule was "creates but never edits", and it broke on the first real scenario — a salesperson learns the delivery address while sitting in PathQuote, and telling them to go and type it into ACT! guarantees it lives only in PathQuote.

The dangerous operation is not writing, it is *silently overwriting*. That is solvable without automatic merge.

### What the API actually does, verified

Create, update and delete were all exercised against the live database on
2026-10-07 and the test record removed afterwards.

| | |
|---|---|
| `POST /api/contacts` | returns the **whole contact object**, not an id string |
| `PATCH /api/contacts/{id}` | needs `id` **in the body as well as the path**; without it, `400` with an empty response |
| `PUT /api/contacts/{id}` | takes the full object; read-modify-write works |
| `DELETE /api/contacts/{id}` | `204`; the service account may delete only records it manages |

The empty-bodied `400` is worth remembering: it looks like a malformed payload
and is actually a missing field the path already carries. Read-modify-write via
`PUT` is the safer default anyway, since optimistic concurrency re-reads the
record before writing regardless.

### Four guardrails

**Whitelist.** The client sends only the fields PathQuote displays and edits — roughly twenty. `recordManager`, `idStatus`, `messengerID`, `customFields/priority`, `referredBy` and every marketing-automation field are never in a payload.

**Optimistic concurrency.** PathQuote stores `edited` as seen at last sync and re-reads the record before writing. If `edited` has moved, the write is abandoned and the salesperson sees both versions. The API has no `If-Match` equivalent, so this is a compare-then-write with a narrow window rather than a true atomic check — acceptable at this volume, and far better than blind overwrites.

**No deletes.** PathQuote never calls `DELETE`.

**Audit trail.** Every write from PathQuote leaves a history record naming what changed.

The rule: **PathQuote creates, fills what is empty, and edits whitelisted fields under optimistic concurrency. It never deletes and never overwrites blindly.**

### Deduplication

Evaluated in order, first match wins.

| Step | Rule | Action |
|---|---|---|
| 0 | `PQ Web Entry ID` already present | return the existing id, write nothing |
| 1 | exact case-insensitive `emailAddress` match among `contactType eq 'Contact'` | update |
| 2 | exact E.164 phone match | update |
| 3 | normalised company name and surname match | create, flag the possible duplicate in a note, raise a review activity |
| 4 | no match | create |

Unlike the earlier design, this ladder runs in our client rather than inside a single server-side transaction, so two simultaneous submissions could in principle both create. At 23 qualified leads a month the risk is negligible, and step 0 catches the realistic case — n8n retrying after a timeout.

The same ladder protects contacts a salesperson types into PathQuote: an existing client returns their existing id and a warning naming the current owner, so PathQuote filters duplicates rather than producing them.

### Strategic consequence

If entering a client is easier in PathQuote, salespeople will do it in PathQuote — always, not sometimes. PathQuote becomes the de facto entry interface and ACT! becomes storage and reporting.

Two things follow. Data quality in ACT! now depends on PathQuote's screens, so validation, required fields, duplicate warnings, and country and phone normalisation have to be good — scope on our side. And there will be pressure to add the rest of the CRM to PathQuote: a note, then call history, then a task. The boundary that prevents a second CRM is the write whitelist.

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

`Region` has six values: `USA` and `Canada` → North America, `Europe` and `United Kingdom` → Europe, `Australia` → Australia, `Other` → empty plus a review flag.

---

## Where the AI output goes

| Output | Destination |
|---|---|
| Overall score, 0–10 | `PQ Lead Score` — filterable and sortable |
| Six sub-scores, narrative, enrichment findings | **a Note** (`POST /api/notes`) |
| Recommended action | activity, type Call, due today, when score ≥ 8 |
| Qualification signals | `customFields/user6` (Industry), `customFields/user2` (Cutter User), `customFields/user3` (Interested in) |

The narrative goes in a Note rather than a History record. In ACT! a history entry records something that happened — a call, a meeting, an email. A note is commentary about the contact. The AI write-up is the second, and keeping it out of History also keeps the response-time metrics clean.

The six sub-scores get no fields. Nobody filters on them, and six extra columns in the contact layout would be scrolled past daily.

### New ACT! fields

Five, created through `POST /api/metadata/contact/fields` — see the reference document. `amaScore` is a first-class API field belonging to Act! Marketing Automation and is never touched.

---

## Telling automatic records from human ones

History written through the API carries the authenticating user. The integration authenticates as its own Act! account — `Marketing`, a dormant account reused for its licence seat and promoted to Manager — so a human touch is any history record whose creator is **not** that account. No text convention, nothing to remember to set, and it works retroactively over everything the integration has ever written.

The name is unhelpful and will read oddly on a quote history line. It is a cosmetic problem, not a functional one: the mechanism keys on the account, not its label. Renaming is deferred.

This is the whole reason the integration does not run under a salesperson's login. Authenticating as a person would attribute robot writes to them, tie the integration to their password, and make "which leads has nobody worked?" and "time to first human contact" unanswerable.

Contacts the integration creates still get their real owner: `recordManagerID` is set explicitly from the territory routing table, so the service account authors the record without owning it.

---

## Write-back

On quote finalisation PathQuote writes a history record of type **`Quote`** (id 62, "A Quote has been produced for an Opportunity") — `Quote Q-AU-2026-014 sent`, with total, currency, line items, validity, PDF link — and creates or updates an opportunity.

Stage mapping is per region, because two processes are live:

| PathQuote region | Process | Stage on "quote sent" |
|---|---|---|
| Australia | Pathfinder Sales Cycle | Proposal (40%) |
| North America | Pathfinder US Sales Process | Engage (40%) |

Quote line items go to `/api/opportunities/{id}/products` as free-form entries, not linked to the ACT! product catalogue. The authoritative catalogue lives in PathQuote, and a second copy in ACT! would be a second source of truth for pricing.

---

## Reporting

Marketing and management reporting queries **ACT!, not PathQuote.**

PathQuote holds a deliberately narrowed copy: active statuses only, sales-relevant fields only, fill-only-empty merge. Leads scored 2 and filtered out, `Accounts` enquiries, and locally edited contacts are all absent or different. Reports built on it would produce numbers that look right and are not, with no visible signal that they are wrong.

The API covers it directly: `GET /api/contacts` with `$filter` for lead volume by period, source and region; `GET /api/contacts/{id}/history` for touches; and `/api/activities/analytics/activity-by-user` for the weekly manager digest. History types identify what counts as a human touch (Call Completed, Meeting Held, E-mail Sent), and the creating account separates automatic records from real ones — subject to the service-account caveat above.

Volume metrics are unaffected by logging discipline. Response-time metrics are: a manager who calls and records nothing looks identical to one who ignored the lead.

---

## Risks

**Licence seat.** The service account consumes an Act! user licence. Seven are active; if all purchased seats are in use, one must be bought or freed before the integration can authenticate.

**Act! upgrades.** The API is versioned, which is why it is safer than the schema. `GET /api/system` reports both API and SDK version; log it on every sync so a surprise upgrade is visible in our own logs before it is visible as a bug.

**Certificate expiry.** Tailscale certificates last 90 days. An unrenewed certificate is the classic quarterly outage.

**Token lifetime.** 65 minutes. The client re-authenticates on `401` rather than assuming a token lives forever.

**Scope creep toward a second CRM.** Contained by the write whitelist.

---

## Decomposition

Three specs, in order of dependency:

1. **PathQuote sync and client UI** — API client, sync worker, the "Load contacts" button, search, the conflict view, `PENDING` / `CONFLICT` in the interface. Depends on nothing but network access.
2. **n8n lead pipeline** — spam filtering, routing, enrichment sources, the scoring rubric, cost controls, retry and dead-letter handling.
3. **Write-back and opportunities** — quote history, opportunity creation, stage mapping.

---

## Open items

| Item | Owner | Blocks |
|---|---|---|
| ~~Network path and HTTPS~~ — done 2026-10-06, source-IP NAT rule, verified end to end | — | — |
| ~~Integration account and permissions~~ — done 2026-10-05, Manager role on `Marketing` | — | — |
| Territory → Record Manager routing table | Pathfinder sales | lead assignment on create |
| Create the five `PQ ` fields via the metadata endpoint | implementation | push |

Everything previously marked as a question for the ACT! vendor is closed: remote databases exist, the opportunity processes and stages are known, the history types are known, and the user list is known. No third-party development is required.
