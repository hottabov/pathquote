# ACT! Integration — Technical Specification for Implementation

**Prepared for:** ACT! database administrator / developer
**Prepared by:** Pathfinder — PathQuote project
**Date:** 2026-09-08
**Status:** For review and estimation
**Version:** 1.0

---

## 1. Purpose

Pathfinder is adding two automated flows around the existing ACT! Premium database. Both need a supported programmatic interface that does not exist yet. This document specifies exactly what that interface must do, which fields it must expose, and which fields it must accept.

The two flows are:

**Flow 1 — inbound leads (write into ACT!).** Enquiries submitted through the contact form on pathfindercut.com are collected by an automation service (n8n), filtered for spam, enriched, scored, and written into ACT! as contacts with an accompanying history record and a follow-up activity for the responsible salesperson.

**Flow 2 — quoting round trip (read from ACT!, write back into ACT!).** PathQuote, an internal quotation application, needs a local copy of contacts so a salesperson can find a client by typing a few characters and issue a quote immediately. When the quote is sent, PathQuote writes a history record and an opportunity back into ACT!.

ACT! remains the single source of truth for contact data throughout. PathQuote holds a read cache and never edits existing ACT! contacts.

---

## 2. Systems involved

| System | Location | Role |
|---|---|---|
| ACT! Premium (Desktop) | Pathfinder office server, SQL Server instance `ACT7` | System of record for contacts, companies, history, activities, opportunities |
| n8n | Pathfinder VPS (public cloud) | Lead intake, spam filtering, enrichment, AI scoring |
| PathQuote | Same VPS as n8n | Quotation application, PostgreSQL database |
| pathfindercut.com | Same VPS | WordPress + Gravity Forms contact form |

Network: the VPS reaches the ACT! server over VPN or a whitelisted static IP. There is no public exposure of the ACT! server, and none is requested.

**Important constraint:** the ACT! database is large (17,373 contacts, 147 fields) and responds slowly. Every requirement in this document is written with that in mind. Nothing in the design performs a full table scan during normal operation.

---

## 3. Questions we need answered before work starts

These are blocking. Please answer them in writing before estimating.

**3.1 Are there remote ACT! databases that synchronise with the main database?** In other words, does anyone work from a synchronised local copy (a laptop database that syncs back to the server)? This single answer determines whether direct SQL writes are merely inadvisable or actively destructive, and it changes the estimate for Part B.

**3.2 Is Act! Premium for Web (APFW) installed or licensed?** We understand it is not, which is why this document specifies a custom write service. If APFW is available, the built-in Act! Web API is an acceptable and preferred alternative — see section 5.1.

**3.3 What is the exact ACT! version and build?**

**3.4 Please supply the list of Opportunity processes and their stages** as configured in this database. We need it to map PathQuote quote states onto ACT! opportunity stages. We have deliberately not guessed.

**3.5 Please confirm the ACT! user list** (login name, display name, email) so we can map ACT! users to PathQuote users. From the export we can see 14 distinct record managers.

---

## 4. Part A — Read interface (ACT! → PathQuote)

### 4.1 Transport

A read-only SQL Server login on the `ACT7` instance, restricted to a dedicated view or stored procedure. We do **not** ask for, and do not want, `SELECT` rights on base tables.

Please provide:

- A SQL Server login `pathquote_read` with `EXECUTE` on the procedure below and no other rights.
- A stored procedure or view exposing exactly the columns listed in 4.4.

We accept either a stored procedure with parameters or a view we filter ourselves. A procedure is preferred because it lets you control the query plan against a slow database.

### 4.2 Operation

```
GetContacts(
    @modifiedSince   datetime2   = NULL,   -- delta cursor; NULL = full extract
    @recordManager   nvarchar    = NULL,   -- ACT! login name; NULL = no owner filter
    @includePublic   bit         = 1,
    @pageSize        int         = 500,
    @afterContactId  uniqueidentifier = NULL  -- keyset pagination cursor
)
```

Ordering must be stable and by `EDITDATE ASC, CONTACTID ASC` so that keyset pagination is correct.

The same operation serves two callers:

- A nightly scheduled job passing `@modifiedSince` = timestamp of the last successful run.
- An on-demand "Load contacts" button in PathQuote, passing the same cursor. There is no second code path.

### 4.3 Filters that must be applied inside the procedure

These are constant and must not be left to the caller:

| Filter | Rule | Effect on current data |
|---|---|---|
| Record type | `Contact Type = 'Contact'` | excludes 20 `User` and 3 `Secondary` records |
| Privacy | exclude `Access Level = 'Private'` unless `@recordManager` matches the record's Record Manager | excludes 108 private records from other users |
| Lifecycle | `ID/Status IN ('Customer', 'Prospect', 'Prospect-Distributor', 'Suspect')` | keeps approximately 12,095 of 17,373 |

Contacts with an empty `ID/Status` are **excluded**. This is a deliberate business decision, not an oversight.

### 4.4 Columns to expose

Field names below are ACT! **display names** as they appear in the export we already hold (`PF_Contacts_20260819.xlsx`). Please map them to the correct physical columns; we do not assume physical names.

**Identity — mandatory, and currently missing from any export we have**

| Column | Type | Note |
|---|---|---|
| `CONTACTID` | uniqueidentifier | The anchor for the entire integration. Without it there is no synchronisation, only a one-off import. |
| `COMPANYID` | uniqueidentifier, nullable | Null when the contact carries a company name but is not linked to a Company record. |
| `EDITDATE` | datetime2 | Delta cursor. Must be the value ACT! itself maintains. |
| `CREATEDATE` | datetime2 | |

**Person**

`First Name`, `Middle Name`, `Surname`, `Name Prefix`, `Name Suffix`, `Salutation`, `Contact`, `Title`, `Department`

**Communication**

`E-mail`, `E-Mail 2`, `Phone`, `Phone Ext-`, `Mobile Phone`, `Phone 2`, `Phone 2 Extension`, `Alt Phone`, `Fax`

**Address**

`Address 1`, `Address 2`, `Address 3`, `City`, `State`, `Postcode`, `Country`, `Web Site`, `Website 2`

**Ownership and routing**

`Record Manager`, `Account Mgr`, `Record Creator`, `Last Edited By`, `Access Level`, `Territory`, `Owner`

**Commercial state**

`ID/Status`, `Stage`, `Priority`, `Industry`, `Referred By`, `Interested in`, `Last Reach`, `Last Attempt`, `Last Meeting`, `Last E-mail`, `Last Results`

**Installed equipment profile**

`Cutter User`, `Cutter 2`, `Cutter 3`, `Cutter 4`, `Cutter 5`, `CAD User`, `CAD 2`, `CAD 3`, `PF Product 1` … `PF Product 5`, `Serial 1` … `Serial 5`, `Intall Date 1`, `Install Date 2` … `Install Date 5`, `Warranty 1` … `Warranty 5`

**New PathQuote fields** (defined in section 5.4)

`PQ Web Entry ID`, `PQ Lead Score`, `PQ Enquiry Type`, `PQ Lead Source`, `PQ Landing Page`

**Fields we explicitly do not want**

Latitude/longitude, `logo`, `Logo1`, `Ticker Symbol`, `AMA Score`, `AEM Opt Out`, `AEM Bounce Back`, `Bounced`, `Email 2 Bounced`, `Spouse`, `Birth Date`, all `Home *` fields, all `User 4` … `User 15` fields, `Assistant`, `Asst- *`, `Pager*`, `4th Contact`, `2nd/3rd Contact` blocks.

Marketing-automation fields are excluded on purpose: they belong to Act! Marketing Automation and Act! Email Marketing and must not be read or written by third-party code.

### 4.5 Company records

We also need company records as a separate result set, because PathQuote models companies and contacts as distinct entities.

```
GetCompanies(@modifiedSince datetime2 = NULL, @pageSize int = 500, @afterCompanyId uniqueidentifier = NULL)
```

Columns: `COMPANYID`, `EDITDATE`, `Company` (name), `Address 1/2/3`, `City`, `State`, `Postcode`, `Country`, `Web Site`, `Phone`, `Fax`, `Industry`, `Territory`, `Record Manager`, `ID/Status`.

If the Company entity is barely used in this database — please tell us the count of linked contacts — we will fall back to deriving companies from the `Company` text field on the contact, and this operation can be dropped from scope.

### 4.6 Performance requirements

- Keyset pagination, not `OFFSET`/`FETCH`. Offset pagination degrades badly at depth on a slow database.
- An index on `EDITDATE` must exist or be created.
- No `SELECT *`. The procedure returns the listed columns only.
- A delta call returning zero rows must complete in under two seconds.
- A full extract of ~12,000 contacts must complete within ten minutes in total across all pages.

---

## 5. Part B — Write interface (n8n and PathQuote → ACT!)

### 5.1 Transport — and why not direct SQL

**Direct `INSERT` / `UPDATE` against `TBL_CONTACT` and related tables is out of scope and must not be proposed.** Reasons, in order of severity:

1. **Synchronisation.** Writes made outside the ACT! business layer are not enqueued for remote-database replication. A contact written directly to the server database will exist on the server and be permanently invisible to anyone working from a synchronised remote copy. See blocking question 3.1.
2. **Referential and trigger logic.** ACT! maintains history linkage tables, field-level triggers, GUID generation, and not-null constraints such as `AEM_OPTOUT`. Reproducing this correctly from outside is possible but fragile and undocumented.
3. **Supportability.** A database written to directly is no longer supportable by Act! and by any future upgrade path.

Two acceptable implementations:

**Option A — custom write service (our recommendation given the current licensing).**
A small .NET service installed on the ACT! server, using the Act! Framework SDK to perform all writes through the supported business layer. It exposes an HTTPS REST endpoint on the internal network / VPN only. This is what the rest of Part B specifies.

**Option B — Act! Premium for Web + built-in Act! Web API.**
If APFW is licensed or can be licensed, the standard Act! Web API covers every write operation in this document with no custom code: `GET /act.web.api/authorize` with HTTP Basic credentials and an `Act-Database-Name` header returns a JWT, then `POST /api/contacts`, `POST /api/histories`, `POST /api/activities`, `POST /api/opportunities`.

The field contract in this document is identical under both options. If you prefer Option B, only section 5.2's transport details change; sections 5.3 to 5.7 stand unchanged. Please tell us which you choose and why.

Under Option B we would still read via SQL (Part A) rather than via the API, because paging 12,000 contacts through REST against a slow database is materially slower than a single indexed query.

### 5.2 Authentication

- HTTPS only, certificate may be internal.
- Static API key in an `X-API-Key` header, or Basic credentials — your choice, but it must be a service account, not a named user's ACT! login.
- Two distinct keys are required, one for n8n and one for PathQuote, so either can be revoked independently. Both keys have identical permissions.
- All requests are logged with caller identity, timestamp, payload, and outcome, retained 90 days.

### 5.3 The upsert operation

A single endpoint handles both creation and update. This is deliberate: if the caller had to search first and then decide, two concurrent form submissions could race and produce duplicates. One transactional operation on the ACT! side cannot.

```
POST /contacts/upsert
```

Two callers use it:

- **n8n**, for every qualified inbound web enquiry.
- **PathQuote**, when a salesperson creates a client that does not yet exist in ACT!. PathQuote sends the same payload with `source = "PathQuote"` and stores the returned `CONTACTID`.

Response, in all cases:

```json
{
  "contactId": "…GUID…",
  "action": "created" | "updated" | "duplicate_flagged" | "ignored_idempotent",
  "matchedOn": "email" | "phone" | "entryId" | null,
  "recordManager": "John Hollo",
  "warnings": []
}
```

### 5.4 Deduplication ladder

Evaluated in order. First match wins.

| Step | Rule | Action |
|---|---|---|
| 0 | `PQ Web Entry ID` already present on any contact | Return `ignored_idempotent` with the existing `contactId`. No writes. |
| 1 | Exact case-insensitive match on `E-mail`, among `Contact Type = 'Contact'` | **Update** |
| 2 | Exact match on E.164-normalised phone against `Phone`, `Mobile Phone`, `Phone 2` | **Update** |
| 3 | Normalised company name **and** surname match | **Do not merge.** Create a new contact, write `possible duplicate of {CONTACTID}` into the history record, and create a review activity. Return `duplicate_flagged`. |
| 4 | No match | **Create** |

Company-name normalisation for step 3: lowercase, strip legal suffixes (`Ltd`, `Pty Ltd`, `GmbH`, `Inc`, `LLC`, `BV`, `SA`, `AB`, `Oy`, `Pty`), collapse whitespace, strip punctuation.

Step 0 exists because n8n retries on timeout. Without an indexed idempotency field, a network hiccup produces duplicate contacts.

### 5.5 Update semantics

When step 1 or 2 matches an existing contact:

- **Only empty ACT! fields are populated.** A field that already holds a value is never overwritten by this integration.
- **The five `PQ ` fields are the one exception** and are always overwritten with the latest values. They describe the most recent enquiry, so a repeat enquiry must refresh the score, source, and landing page rather than keep a stale first-touch value. The previous values are preserved in the history record, so nothing is lost.
- **`Record Manager` is never changed.** If the matched contact belongs to another salesperson, ownership stays with them and the incoming enquiry is recorded as history against their contact. The response returns the existing `recordManager` so the caller can inform the user.
- A history record is always written, whether or not any field changed.

### 5.6 New custom fields

Five new contact fields are required. Please create them via `Tools → Define Fields` with the `PQ ` prefix so their origin stays obvious.

| Field name | Type | Size | Indexed | Purpose |
|---|---|---|---|---|
| `PQ Web Entry ID` | Character | 20 | **Yes** | Gravity Forms entry id. Idempotency key for step 0 above. The index is required — a text search across history on 17k records is too slow. |
| `PQ Lead Score` | Number, 1 decimal | — | Yes | AI overall score, 0.0–10.0. Lets a salesperson run a lookup for score ≥ 8 and sort by it. |
| `PQ Enquiry Type` | Dropdown | — | No | Values: `General`, `Machinery Sales`, `Parts & Consumables`, `Technical Support`. Drives routing and reporting. |
| `PQ Lead Source` | Character | 100 | No | Derived attribution, e.g. `Organic / Google`, `Referral / thomasnet.com`, `Paid / google cpc`. |
| `PQ Landing Page` | Character | 255 | No | First page of the site the lead landed on. |

The six sub-scores produced by the AI (intent, company size, industry match, budget probability, existing relationship, decision maker identified) deliberately do **not** get fields. They are narrative context, nobody filters on them, and six extra columns in the contact layout would be scrolled past daily and never used. They go in the history record.

**Do not repurpose `AMA Score`.** It is empty in all 17,373 records only because Act! Marketing Automation is inactive. If that module is ever enabled it will claim the field. The same applies to `AEM Opt Out`, `AEM Bounce Back`, `Bounced`, and `Email 2 Bounced`.

### 5.7 Write field mapping

Source is the website form (Gravity Forms) plus AI enrichment. The form has conditional branches, so several logical values arrive in one of two columns; the caller resolves these before sending, and the payload the endpoint receives is already flat.

**Contact fields**

| Payload key | ACT! field | Rule |
|---|---|---|
| `firstName` | `First Name` | also written to `Salutation` on create, matching the existing convention in this database |
| `lastName` | `Surname` | |
| `namePrefix` | `Name Prefix` | |
| `nameSuffix` | `Name Suffix` | |
| `company` | `Company` | |
| `position` | `Title` | |
| `email` | `E-mail` | lowercased before write |
| `phoneE164` + `phoneType` | `Mobile Phone` when type is `MOBILE`, otherwise `Phone` | already validated and normalised by the website; no further parsing needed |
| `street1` | `Address 1` | |
| `street2` | `Address 2` | |
| `city` | `City` | |
| `state` | `State` | |
| `postcode` | `Postcode` | |
| `countryName` | `Country` | full country name, e.g. `United States`, matching existing values |
| `territory` | `Territory` | `USA → North America`, `Australia → Australia`, `Europe → Europe`, `Other → empty + review flag` |
| `enquiryType` | `PQ Enquiry Type` | |
| `productInterest` | `Interested in` | only when empty |
| `webEntryId` | `PQ Web Entry ID` | |
| `leadSource` | `PQ Lead Source` | |
| `landingPage` | `PQ Landing Page` | |
| — | `Referred By` | constant `Web` on create (n8n) or `PathQuote` on create (PathQuote) |
| — | `Access Level` | `Public` on create |
| — | `ID/Status` | `Suspect` on create. Not `Prospect`: in this database `Prospect` means someone has spoken to them, and a web lead has not been qualified yet. |
| — | `Record Manager`, `Account Mgr` | assigned from `territory` using a routing table you and we agree separately |

**AI enrichment fields, all written only when the ACT! field is currently empty**

| Payload key | ACT! field | Rule |
|---|---|---|
| `leadScore` | `PQ Lead Score` | always written, per the exception in 5.5 |
| `industry` | `Industry` | only if the value already exists in the current industry list; never creates a new entry |
| `existingCutter` | `Cutter User` | |
| `productInterest` | `Interested in` | |
| `priority` | `Priority` | `≥ 8 → High`, `5.0–7.9 → Medium`, `< 5 → Low` |

**Serial and machine model.** Support enquiries carry `Machine Model` and `Serial Number`. Write `Serial Number` to `Serial 1` only when `Serial 1` is empty; otherwise record it in the history body. Never overwrite an existing serial.

### 5.8 History record

Written on every successful upsert, whether create or update.

```
POST /histories
```

| Attribute | Value |
|---|---|
| Type | `Other` |
| Regarding | `Web enquiry — {enquiryType} — score {leadScore}` |
| Date | the form submission timestamp, not the write timestamp |
| Contact | the resolved `CONTACTID` |
| Record Manager | the contact's record manager |
| Details | see below |

Details body contains, in this order: the customer's own message verbatim; the six AI sub-scores; the AI recommendation for the salesperson; the enrichment findings (company website, industry, apparent size, years trading, equipment already owned); full attribution (original referrer, landing page, traffic source, UTM parameters, click ids); the Gravity Forms entry id; submission IP and user agent.

### 5.9 Activity

Created only when `leadScore >= 8`.

```
POST /activities
```

Type `Call`, scheduled for the current day, assigned to the contact's Record Manager, subject `Follow up web enquiry — {company}`, priority High, with an alarm.

### 5.10 Opportunity from a lead

Created only when `leadScore >= 8` **and** `enquiryType = 'Machinery Sales'`.

Fields: name `Web lead — {company} — {productInterest}`, associated contact and company, opportunity stage = the first stage of the process you supply per question 3.4, estimated close date = submission date + 90 days, probability = `leadScore * 10`, no products attached at this point.

---

## 6. Part C — Write-back from PathQuote

When a quotation is finalised and sent to the client, PathQuote writes back.

### 6.1 History

```
POST /histories
```

Type `Other`. Regarding `Quote {number} sent` — for example `Quote Q-AU-2026-014 sent`. Contact resolved by the `CONTACTID` PathQuote already holds. Record Manager is the quote's author mapped to their ACT! login. Details contain the quote total and currency, the line items, the validity period, the delivery terms, and a link to the PDF.

### 6.2 Opportunity

```
POST /opportunities
PUT  /opportunities/{id}
```

| Attribute | Value |
|---|---|
| Name | `{quote number} — {primary product}` |
| Contact / Company | resolved from `CONTACTID` |
| Amount | quote total |
| Currency | quote currency (AUD, USD, …) |
| Estimated close date | issue date + validity days |
| Probability | from the quote state |
| Stage | mapped from the quote state — **mapping to be agreed once you supply the stage list, question 3.4** |
| Products | quote line items as `name`, `quantity`, `price` |

Line items are sent as free-form product entries. They are deliberately **not** linked to the ACT! product catalogue: the authoritative product catalogue lives in PathQuote, and maintaining a second copy inside ACT! would create two sources of truth.

### 6.3 What PathQuote never does

PathQuote **creates** contacts in ACT! and **appends** history and opportunities. It never edits an existing ACT! contact's fields.

If a salesperson corrects a phone number inside PathQuote, that correction stays local, is flagged as a divergence from ACT!, and does not propagate. Bidirectional field-level synchronisation with conflict resolution is explicitly out of scope. Corrections belong in ACT!, and the next sync brings them across.

---

## 7. Security requirements

- No component of this integration is exposed to the public internet. All endpoints listen on the internal network or VPN interface only.
- The read login has execute rights on the specified procedures and nothing else.
- The write service runs under a dedicated ACT! service account, not a salesperson's login.
- Separate API keys per caller, independently revocable.
- Full request logging with 90-day retention.
- Personal data in transit is TLS-protected. The website already captures submitter IP and user agent; these are stored in ACT! history and are subject to the same retention rules as the rest of the CRM.

---

## 8. Acceptance criteria

The work is complete when all of the following can be demonstrated:

1. A delta read call with a `modifiedSince` cursor returns only contacts edited after that timestamp, in stable order, paged, with `CONTACTID` present on every row.
2. A delta call matching zero rows returns in under two seconds.
3. A full extract of the filtered contact set (~12,000 records) completes within ten minutes.
4. A read call scoped to one Record Manager returns that manager's contacts plus public contacts, and excludes other managers' private records.
5. Submitting the same `PQ Web Entry ID` twice produces exactly one contact and one history record.
6. An upsert matching an existing contact by email updates only previously empty fields, leaves `Record Manager` unchanged, and adds a history record.
7. An upsert matching by company name and surname creates a contact, flags the possible duplicate in history, and creates a review activity.
8. A contact created through the endpoint is visible and correctly formed in the ACT! desktop client, including history and activity.
9. If remote databases exist: a contact created through the endpoint replicates to a remote database on the next synchronisation.
10. PathQuote can create a contact, receive a `CONTACTID`, and subsequently post a history record and an opportunity against it.

---

## 9. Out of scope

- Editing existing ACT! contact fields from PathQuote.
- Bidirectional field-level synchronisation and conflict resolution.
- Shipping/delivery address fields — the website form collects them but they are unused in practice (0 of 28 submissions over 30 days) and ACT! has no matching contact-level block.
- Linking quote line items to the ACT! product catalogue.
- Any read or write of Act! Marketing Automation or Act! Email Marketing fields.
- Migration or cleanup of existing data quality problems in ACT!.

---

## 10. Appendix — data observations

From `PF_Contacts_20260819.xlsx`, 17,373 contacts, 147 fields. Field population rates are given because they justify several decisions above.

| Field | Populated | Relevance |
|---|---|---|
| `Record Manager` | 100% | Ownership filter is safe to rely on |
| `Edit Date` | 100% | Delta cursor is safe to rely on |
| `Company` | 99.0% | |
| `Country` | 97.0% | |
| `ID/Status` | 92.0% | 1,393 records have none and are excluded |
| `Phone` | 90.8% | |
| `E-mail` | 79.0% | Too sparse to be an identity key on its own — hence `CONTACTID` |
| `Referred By` | 82.2% | Already contains `Web` 1,447 times, `LinkedIn` 268 times |
| `Industry` | 75.9% | |
| `Cutter User` | 24.0% | Existing home for "what equipment do they already have" |
| `Interested in` | 8.0% | |
| `AMA Score` | 0% | Reserved by Act! Marketing Automation — do not use |

Record manager distribution: John Hollo 5,713 · Chris Gilmartin 2,747 · David Cook 2,211 · Rick Weaver 1,481 · John Kyprianou 1,376 · Wayne Walker 1,017 · Xavier Martel 696 · Brandon Clark 536 · Dan Hall 480 · Mike Collins 338 · Marketing 284 · Dan Castaneda 148 · Martin Thornton 133 · Monte Kimball 129.

Status distribution: Prospect 9,559 · Dead Prospect 1,476 · empty 1,393 · Customer 1,229 · Suspect 1,111 · Contact-Industry 546 · Supplier 480 · Prospect-EX 352 · Personal 282 · Prospect-Distributor 196 · Competitor 165 · Customer-Ex 135 · other 449.

---

## 11. Response requested

Please reply with:

1. Answers to the five blocking questions in section 3.
2. Your choice between Option A (custom service) and Option B (Act! Premium for Web), with reasoning.
3. An estimate broken down by Part A, Part B, and Part C.
4. Any field in section 4.4 or 5.7 that cannot be exposed or written as specified, and why.
5. Anything in this document you believe is technically wrong. We would rather find out now.
