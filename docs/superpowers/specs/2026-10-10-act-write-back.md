# Phase 3: writing back to ACT!

**Status:** design. Three decisions below need Vadym's answer, and one prerequisite blocks everything that attributes a record to a person.

**Why now:** phases 1 and 2 made ACT! → PathQuote work and put it on a nightly timer. Nothing goes the other way, so a quote sent from PathQuote leaves no trace in the CRM the business actually runs on, and a correction a manager makes while quoting never reaches ACT!.

**Decided in conversation 2026-10-10** (recorded here so it is not reopened): one Opportunity per deal with revisions updating it; contacts and companies created in PathQuote are created in ACT! automatically; PathQuote may push every field it holds **except** `Company.name`, `notes`, and `industry` — see §6.

---

## 1. The split that governs everything

Two jobs, one word. They have different risk and should ship separately.

**Append-only.** A quote is sent; PathQuote creates a History record and an Opportunity in ACT!. We create new records and touch no existing field. **No conflict is possible** — nobody else is writing the History entry we are about to create. This half needs no conflict policy at all.

**Field mutation.** A manager edits a contact in PathQuote and it should reach ACT!. Other people edit the same record concurrently, and ACT! replicates to twelve managers' laptops. All the difficulty lives here.

Shipping them together would hold the first behind the second for weeks. The order in §8 reflects that.

---

## 2. What is already fixed, and where

Do not re-decide these.

| Decision | Source |
|---|---|
| `CONFLICT` shows both versions side by side and a person chooses. **Nothing merges automatically.** | `specs/2026-09-08-act-integration-design.md:200` |
| `ActSyncState` is `SYNCED` / `PENDING` / `CONFLICT`, frozen in phase 1 so phase 3 cannot invent a second vocabulary | `prisma/schema.prisma:117-126` |
| Optimistic concurrency: store `edited` as seen at last sync, re-read before writing, abandon the write if `edited` moved. The API has no `If-Match`, so this is compare-then-write with a narrow window | design doc 358-368 |
| No deletes, ever, outbound | design doc 358-368 |
| Every write from PathQuote leaves a History record naming what changed | design doc 358-368 |
| Quote write-back uses History type **62 "Quote"** | `act-integration-reference.md` §7 |
| Line items go to `/api/opportunities/{id}/products` as free-form entries, **not** linked to ACT!'s product catalogue — the authoritative catalogue is PathQuote's, and a second copy would be a second source of truth for pricing | design doc 447-456 |
| The integration authenticates as `Marketing` (`d90f208e-6468-4251-89d8-4937b0c70182`), Manager role since 2026-10-05, and is the author of every record it writes | reference §2 |
| `Define Fields` is deliberately **not** granted to that account | reference §2 |
| The Web API is the only write path. Direct SQL would not be queued for replication | reference §1 |
| The API is IP-allowlisted to `74.208.106.34` | reference §11 |

The per-region stage map, also already fixed (reference §8):

- **Pathfinder Sales Cycle** `2380e83d-cef4-4b6d-ad15-dc9a558431ab` — Initial Communication 5% · Needs Assessment 10% · Presentation 20% · **Proposal 40%** · Negotiation 65% · Verbal Commitment 90% · Sales Fulfillment 100%
- **Pathfinder US Sales Process** `26ab3a1e-ff20-406d-a0b4-3b351955da45` — Assess 20% · **Engage 40%** · Build Develop 60% · Gain Commitment 80% · Execute Fulfilment 100%
- A sent quote maps to `Proposal` (AU) or `Engage` (US).

---

## 3. Stage 1 — quote → History and Opportunity

### 3a. What identifies the deal

`Document` **is** the deal. A revision is not a new row: `QuoteRevision` is a child keyed `@@unique([documentId, revision])`, and `Document.number` survives every revision *and* an unfinalize → re-finalize cycle (`src/lib/actions/finalize.ts:234`).

So the Opportunity is keyed on **`Document.id`**, never on a revision. Store ACT!'s own id back in PathQuote: a new `Document.actOpportunityId`.

**Idempotency for History is different**, because History is a journal: one entry per send, and a resend after a bounce is a real second send. There is already a row per send — `SigningRequest`, one per send, revoked when a resend supersedes it. So **key each History record on `SigningRequest.id`** and store `SigningRequest.actHistoryId`. That reuses an identity that already exists instead of inventing one.

**Why PathQuote stores the ACT! ids rather than stamping a PathQuote id into an ACT! custom field:** the five `PQ ` custom fields do not exist yet, and creating them needs `Define Fields`, which the service account deliberately does not have (reference §2). That path is blocked on an administrator login. And "which ACT! record did I create for this quote" is PathQuote's fact to keep.

### 3b. Where to hook

Sending is **split across two server actions**, both in `src/lib/actions/signing.ts`:

- `sendQuoteForSignature` (304) — the bare signing invite. Writes `sentAt`, **emits no `QuoteEvent`**.
- `sendQuoteToClient` (492) — the rich dialog. Writes `sentAt`, a `QuoteEmail` row **and** a `QuoteEvent { type: "SENT" }`.

Hooking `QuoteEvent` would therefore silently miss half of all sends. Hook the **status transition into `SENT`**, which both perform with the same guarded `updateMany`, by having both call sites enqueue an outbox row inside the same transaction that sets `sentAt`.

For the won case, use **`ACCEPTED`, not `SIGNED`**. `acceptQuote` (`finalize.ts:678-718`) is already idempotent (`if (document.acceptedAt) return { ok: true }`) and already emits a `QuoteEvent`. `SIGNED` can be undone — `voidSignature` clears the CLIENT signature row.

### 3c. What the Opportunity hangs off — the hard part

An ACT! Opportunity needs a contact and/or a company. PathQuote can often name neither:

- `Contact.actContactId` is set for imported contacts and **null for any contact typed into PathQuote**.
- `Company.actCompanyId` is set for only about 126 companies against 8,809 — roughly 1.5%. The rest are *derived* from the free-text company name on a contact, via `actCompanyKey`. ACT!'s own Company records are not fetched at all in phase 1.
- `Document.companyId` and `Document.contactId` are **both nullable** (`schema.prisma:876-878`), and `contactId` has no primary-contact fallback. A FINAL quote can legally carry a company and no contact.

**Decision: hang the Opportunity on the contact, and associate the company only when `actCompanyId` is known.** A contact is the identity we actually have.

When neither is available, the write cannot be made. It must **not** be silently dropped: the outbox row is marked blocked with a reason, and the quote shows it. A manager who sent a quote and sees nothing in ACT! must be able to find out why without reading a log. Stage 2 then removes most of this class by creating the missing contact in ACT!.

### 3d. Stage movement, and the fact that sending is not monotonic

A send can be undone. Both send actions restore the previous status if the mail fails (`signing.ts:440-445, 642-647`); `revokeSigningLink` returns a quote to `NOT_SENT` (794); `unfinalizeDocument` does too (581, 653).

**Decision: the stage only ever moves forward, by probability.** If the Opportunity is already at Negotiation (65%), a sent quote does not pull it back to Proposal (40%).

**A withdrawal writes a History entry recording the withdrawal and does not move the stage back.** Two reasons. "This deal reached proposal" stays true after an email is revoked. And moving someone else's Opportunity backwards is exactly what destroys a director's confidence in his own pipeline numbers — if a deal has died, Closed-Lost is a judgement a human makes in ACT!, not something a revoked email should infer.

### 3e. Currency

`Document.currency` is snapshotted per region: AUD, USD, GBP. There is **no FX anywhere in the schema**.

Write the Opportunity value in the quote's own currency and do not convert. Inventing a rate would be worse than mixed currencies, because it would be wrong silently. Worth telling the director once: an ACT! pipeline total that sums across regions will be mixed-currency.

---

## 4. Stage 2 — creating contacts and companies in ACT!

Decided: automatic. The reasoning is that otherwise ACT! stops being the system of record, and within a year PathQuote holds a layer of clients the CRM cannot see and nobody knows whose they are.

Mechanically this is append-only, so no conflict policy applies. Two things to respect:

- `POST /api/contacts` returns **the whole contact object**, not an id string (design doc) — so the created record is available to store as the first `ActSnapshot` immediately.
- The deduplication ladder in the design doc (370-382) exists for the web-form path and applies here too. Its own caveat stands: it runs in our client rather than one server-side transaction, so two simultaneous creates could both succeed. The outbox serialises our side of that.

Creating a company is harder than creating a contact and should follow Stage 3, because today PathQuote cannot tell whether a derived company already exists in ACT! — it has never read ACT!'s Company records.

---

## 5. Stage 3 — reading `/api/companies`

A prerequisite for two things rather than a feature of its own: pushing a shipping address (§6), and knowing whether a company already exists in ACT! before creating one (§4).

It also closes a known gap: `Company.name` in PathQuote came from the free-text `company` field on a contact, not from ACT!'s Company record.

---

## 6. Stage 4 — field write-back

### 6a. The whitelist

Decided 2026-10-10: everything PathQuote holds, **except** three.

| Field | Push? | Why |
|---|---|---|
| `Contact.email`, `Contact.phone` | yes | The real case: a manager on a call gets a new mobile and types it into PathQuote while quoting |
| `Contact.position` | yes | Low risk, not an identifier |
| `Contact.firstName`, `lastName` | yes | Not identifiers either — `actContactId` is. Three-way merge means only a genuine local change is pushed |
| `Company.street/city/state/postcode` | yes, into ACT!'s **`shippingAddress` only** | Never the business address. PathQuote holds one address; ACT! holds three, and pushing one into the wrong slot flattens the others. Needs Stage 3 first |
| `Company.website`, `Company.country` | yes, **per edit only** | One record at a time is fine. A bulk normalisation is a one-off script, not continuous write-back — see below |
| **`Company.name`** | **never** | See 6b |
| **`Company.notes`** | **never** | The sync itself writes there (`recordGenericChannel`, `sync.ts:475-491`). Pushing it would send our own generated text into a human field of a twenty-year-old CRM, and ACT! notes are a separate entity anyway |
| **`Company.industry`** | **never continuously** | The director's goal of standardising ACT! industries to PathQuote's list is right, but its value is a one-off cleanup, modelled on `scripts/act-fix-country-spellings.py`: dry run, list for review, then `--apply`, out of hours. Continuous push would mean PathQuote's taxonomy silently rewriting an ACT! field every time a manager saves a client card — a decision the director should make once, deliberately, not receive as a side effect |

The `website` / `country` distinction matters: **per-record on edit is fine, bulk is a script.** A bulk push would move `edited` on thousands of records, make the next inbound sync re-read all of them, and replicate the lot to twelve laptops in one night.

### 6b. Why `Company.name` is never pushed

`actCompanyKey` is `normaliseCompanyName(name) + "|" + countryCode`, written once at creation and **never recomputed**. That is deliberate: matching compares against the stored key rather than the current name, which is what makes renaming a company inside PathQuote safe.

Push a rename to ACT! and the next *new* contact at that company computes a key from the new name, fails to match the stored key, misses, and **creates a second company**. The first client's quotes stay on the first row. That is precisely the split the key exists to prevent, and it is already documented as "key drift" in `specs/2026-10-08-act-visibility-and-search.md:49-95`. Today it is a risk when someone renames in ACT!; pushing renames would make it a certainty.

Renaming belongs in ACT!, where it is one field and propagates downward.

If this is ever wanted, it is its own project — key recomputation plus a merge path — and larger than the whole of the rest of this spec.

### 6c. The merge, and a trap in `ActSnapshot`

`fillOnlyEmpty` (`src/lib/act/merge.ts:26-37`) is one-directional and has **no notion of a base version**. It is not a three-way merge and cannot become one.

The base for a real three-way merge is `ActSnapshot` — and **it is only usable for contacts**:

- A contact-owned row holds **the raw ACT! record** as last seen (`map.ts:134`, `snapshot: contact`). Three-way merge works.
- A company-owned row holds **the mapped PathQuote shape**, already normalised — street joined, city case-fixed, country converted to ISO, industry resolved to a PathQuote id (`sync.ts:396,467`). The schema says why (1511-1514): a derived company has no ACT! record of its own.

So company field write-back has no merge base until Stage 3 fetches real ACT! Company records. **Contact fields can be merged now; company fields cannot.** That is the second reason Stage 3 precedes company writes.

Per field, comparing base / PathQuote / ACT!:

| base → local | base → remote | action |
|---|---|---|
| changed | unchanged | push to ACT! |
| unchanged | changed | pull into PathQuote — note this is a **change from today**, where `fillOnlyEmpty` refuses to overwrite a non-empty local value |
| changed, same value | changed, same value | nothing |
| changed, differently | changed, differently | `CONFLICT`: show both, a person chooses |

Push the **field**, not the record. Otherwise a phone correction in PathQuote overwrites an email somebody fixed in ACT! ten minutes earlier.

---

## 7. Cross-cutting requirements

These hold whatever the policy is.

### 7a. An outbox, because a customer-facing action cannot depend on the CRM

Sending a quote to a customer **must not fail because ACT! is unreachable**. Today every external call in this app is inline (`signing.ts` awaits its mail send and compensates on failure). An inline ACT! write would put a CRM outage in the path of a sale.

No queue exists — `src/lib/actions/act-sync.ts:95` says so outright, and declines to build one for a button whose ordinary case is seconds. A write-back is the case that changes that answer.

New model `ActOutbox`: the work kind, the PathQuote row it concerns, the payload, attempt count, last error, next attempt time, completion time, and a blocked reason for the §3c case. The precedent for shape is `SupportMessage.emailedAt` / `emailError` (`schema.prisma:1336-1341`), whose own comment says there is no retry mechanism yet but the shape does not rule one out.

**Drain it immediately before the inbound sync, in the same run, under the existing advisory lock.** That ordering is not incidental: writes land first, so the inbound read that follows sees them and records them as our own echo (7b) rather than as twelve remote changes.

### 7b. Echo suppression, or it loops

Every ACT! write bumps `edited`, which **is** the inbound delta cursor. So every write-back makes the next sync re-read what it touched. Worse, write → read-back → write is a loop.

After each successful write, store the returned record as the new `ActSnapshot` and update `actSourceEditedAt`. The record still appears in the next delta — `edited ge` guarantees that — but it no longer *looks* like a remote change, so nothing re-queues it.

One side effect worth naming: a burst of writes creates a cluster of identical `edited` values, and `$skip` paging over a tie cluster is already known to return rows twice (reference §10, the "72 contacts returned twice" anomaly). A write-back makes that more likely, not less.

### 7c. The client has to be built

`src/lib/act/client.ts` is **strictly read-only**: two methods, `system()` and `contactsEditedSince()`. Its private `send()` takes `(label, url, headers)` — no body, no method — so it cannot POST at all without widening.

What the Python scripts already prove works, and what the TypeScript client must copy:

- `PATCH /api/{collection}/{id}` **requires `id` in the body as well as the path**; without it, `400` with an empty response.
- Addresses are nested objects and **a partial write blanks the siblings**, so the whole record is read, one field changed, and the whole object written back.
- Those scripts have no retry and treat any HTTP error as fatal. The TypeScript client's existing rules are better and should apply: retry network errors, timeouts and 5xx; never retry 4xx; re-authorise once on 401.

### 7d. Where it can run

The API is IP-allowlisted to the VPS. A developer laptop gets `403` with correct credentials, so **write-back cannot be tested locally** without a tunnel. Plan verification on the box, as phase 2 did.

### 7e. Timing

Writes replicate to twelve managers' laptops. Both Python scripts say the same thing: out of hours is kinder. The nightly drain at 03:00 Melbourne already satisfies this; a manual drain should not be offered without saying so.

---

## 8. Order of work

1. **Prerequisite: map PathQuote users to ACT! users** (§9). Blocks anything that attributes a record to a person.
2. **Quote sent → History 62 + Opportunity**, with the outbox, echo suppression, and the write half of the client. Append-only, no conflicts, and it is what gives the director a pipeline.
3. **Create missing contacts in ACT!** Removes most of the §3c blocked-write class.
4. **Read `/api/companies`.** Unblocks shipping addresses and company creation.
5. **Contact field write-back** with three-way merge and `CONFLICT`. Hardest, last, and the only part needing a conflict UI.

Company field write-back comes after 4 and 5 and is deliberately not scheduled here.

---

## 9. Prerequisite: nobody is mapped to an ACT! user

`User.actUserId` and `User.actAccountMgr` exist in the schema (307-309) and are **populated nowhere**. No script sets them, no UI edits them, nothing reads them. A grep finds only the schema and the `z60_act_sync` migration.

Without the mapping, every record PathQuote creates is owned by the `Marketing` service account — so twelve managers' quotes all appear in ACT! as Marketing's opportunities, and the pipeline is useless for exactly the person who asked for it.

`GET /api/users` is available (reference §9). The work is a script to list ACT! users beside PathQuote users, plus a field on the user settings page. Small, and it gates everything in §8 step 2 onward.

---

## 10. Decisions needed

### D1. The UK region has no ACT! sales process

`REGIONS` ships **three** regions — AU, US and **UK** (`prisma/seed-lib.ts:97-142`). The stage map covers two. A UK quote has nowhere to go.

Options: skip Opportunity write-back for UK quotes and write only the History record; create a UK process in ACT! (an administrator task, not ours); or route UK onto the AU process.

**Recommendation: History only, no Opportunity, until a UK process exists** — and say so on the quote, so it is visible rather than silently absent.

### D2. What happens when the quote's author is not mapped to an ACT! user

Given §9 will not be complete for everyone at once: block the write and show it as blocked, or write the record owned by `Marketing`?

**Recommendation: block.** An Opportunity owned by Marketing is worse than no Opportunity, because it pollutes the pipeline the feature exists to produce, and it is invisible as an error. A blocked outbox row with a reason is visible and fixable in one click once the user is mapped.

### D3. Does `ACCEPTED` close the Opportunity?

A quote reaching `ACCEPTED` could move the stage to the 100% stage — Sales Fulfillment (AU) or Execute Fulfilment (US) — or leave closing as a human step in ACT!.

**Recommendation: move it.** `acceptQuote` already requires FINAL + SIGNED + an author signature, so it is a real commercial event, not a click. But this is the sales team's process rather than mine to decide, and it is the one of the three most worth overruling me on.

---

## 11. Not in this spec

Deletions. The cursor is `edited` and the filter is `edited ge`, so a contact deleted in ACT! never appears in the delta and PathQuote keeps it indefinitely; `--full` does not help, because it fills blanks and never compares its result set against what PathQuote holds. **Nothing anywhere detects this.** It is buildable from existing columns — `actSyncedAt` is set on every touch, so "not seen during the last full run" is a query — but it is an inbound problem and belongs with the inbound sync, not here.

Also out: the n8n lead pipeline (stage 1 of the original brief); `hasUnsentChanges`, which is the real "the client's copy is stale" signal and has no ACT! analogue; and the five `PQ ` custom fields, which need an administrator because `Define Fields` is not granted to the service account.
