# Write-back: a finalised quote reaches ACT! — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a manager finalises a quote, ACT! gains a History record and an Opportunity, and any contact that existed only in PathQuote is created in ACT! on the way.

**Architecture:** Finalising enqueues one `ActOutbox` row inside the same transaction that allocates the quote number. A drain worker runs the row's steps in order — contact, opportunity, history — writing each result back so the next inbound sync recognises its own echo. The drain runs immediately after finalise off the request path, and again from the nightly timer before the inbound read, so a CRM outage never blocks a sale.

**Tech Stack:** Next.js server actions, Prisma/Postgres, ACT! Web API v1.1, systemd, vitest.

**Context:** `docs/superpowers/specs/2026-10-10-act-write-back.md` holds the decisions and the reasoning; read §3, §7 and §10a before starting. Phases 1 and 2 (inbound sync, nightly timer, Settings page) are live in production.

---

## What this plan does NOT do

Company **creation** in ACT!, and any push of contact or company **fields**. Both need `/api/companies` read first (spec §5), and field pushes need the three-way merge the spec defers to its own stage. A quote whose company has no `actCompanyId` still gets its Opportunity — hung on the contact, with no company linked.

---

## Facts established before writing this, with sources

Everything below was read off `RAW/ACT/swagger.json`, `RAW/ACT/meta/*.json` or the live API on 2026-10-12. **Do not re-derive these; do verify any you depend on in a way the plan does not already state.**

**`POST /api/History`** takes `act.web.api.models.Histories.History`. Swagger declares **no required fields**. Useful properties: `historyTypeID` (int32), `regarding`, `details`, `startTime`, `endTime`, `recordManagerID` (uuid), `isPrivate`, `contacts[]`, `companies[]`, **`opportunities[]`**.

> That last one settles the spec's open question: a type-62 history **can** link to an opportunity but is **not required** to. So the order contact → opportunity → history is a choice for coherence, not an API constraint.

**`POST /api/opportunities`** takes `act.web.api.models.Opportunities.Opportunity`, also with no declared required fields. Useful: `name`, `stage` (a `Stage` object), `probability` (int32), **`status`** (string — where Won/Lost lives), `reason`, `openDate`, `estimatedCloseDate`, `actualCloseDate`, `stageStartDate`, `contacts[]`, `companies[]`, `recordManagerID`, `productTotal`, `weightedTotal`, `grossMargin`, `customFields`.

> **There is no currency field anywhere on an Opportunity.** See Task 2.

**Embedded references are id-only:** `EmbeddedContact` is `{ id, displayName, company }`, `EmbeddedCompany` is `{ id, name }`, `EmbeddedOpportunity` is `{ id, name }`. A uuid is enough.

**`Stage`** is `{ id, name, description, probability, number, process }`. **`number` is the ordering within a process** — use it for the forward-only rule, not `probability`, because the legacy process has thirteen stages all at 0% and ties are meaningless.

**Stage ids**, from `RAW/ACT/meta/opp_stages.json`:

| Process | id | Sent stage | Won stage |
|---|---|---|---|
| Pathfinder Sales Cycle (AU, UK) | `2380e83d-cef4-4b6d-ad15-dc9a558431ab` | Proposal `5e3bb017-ab1a-468a-8d58-0f71d6df9cbf` (40%, number 4) | Sales Fulfillment `2fc8fb09-24bb-4b24-a97c-f5ceedb7b39c` (100%, number 7) |
| Pathfinder US Sales Process (US) | `26ab3a1e-ff20-406d-a0b4-3b351955da45` | Engage `ddf43a76-f167-4268-9cce-4be315903729` (40%, number 2) | Execute Fulfilment `6a03c159-b1fa-4fa9-9359-612c8e9e4369` (100%, number 5) |

**Products live at `/api/opportunities/{opportunityId}/products`** (GET, POST) — note `opportunityId`, not `id`; the reference doc's `{id}` was loose.

**The service account** is `Marketing`, `d90f208e-e1fd-4835-8811-541b0c4b81b9`, **role Manager, Active** — confirmed live 2026-10-12. It has no email. It is the author of everything written.

**`PATCH` requires `id` in the body as well as the path**, or it answers `400` with an empty body. Nested objects must be written whole: a partial write blanks the siblings. Both proven by `scripts/act-fix-country-*.py`.

**The API is IP-allowlisted to `74.208.106.34`.** Nothing here can be tested from a laptop.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/act/opportunity-stages.ts` | create — region → process and stage, and the forward-only rule |
| `src/lib/act/write-payloads.ts` | create — build the History and Opportunity bodies from a quote |
| `src/lib/act/outbox-plan.ts` | create — which steps a row still needs, and whether it is blocked |
| `prisma/schema.prisma` + `prisma/migrations/z65_act_outbox/migration.sql` | modify/create — `ActOutbox`, `Document.actOpportunityId`, `QuoteRevision.actHistoryId` |
| `src/lib/act/client.ts` | modify — a write path, then `createHistory`, `createOpportunity`, `updateOpportunity`, `getOpportunity`, `createContact`, `getContact` |
| `src/lib/act/outbox.ts` | create — enqueue, and the drain worker |
| `src/lib/actions/finalize.ts` | modify — enqueue inside the finalise transaction |
| `src/lib/act/sync.ts` | modify — drain before the inbound read |
| `src/components/documents/*` | modify — show a quote's ACT! state |
| `docs/runbook.md` | modify — §4d |

The three pure modules hold every decision and get tests. `client.ts` and `outbox.ts` stay thin I/O shells, consistent with the architecture rule phases 1–2 followed.

---

### Task 1: The stage map, and forward-only

**Files:** create `src/lib/act/opportunity-stages.ts`, `tests/act-opportunity-stages.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { processForRegion, sentStage, wonStage, shouldMoveStage } from "../src/lib/act/opportunity-stages";

describe("processForRegion", () => {
  it("puts AU and UK on the Pathfinder Sales Cycle", () => {
    expect(processForRegion("AU")?.processId).toBe("2380e83d-cef4-4b6d-ad15-dc9a558431ab");
    // UK has no sales process of its own; decided 2026-10-12 rather than
    // leaving British quotes with nowhere to go.
    expect(processForRegion("UK")?.processId).toBe("2380e83d-cef4-4b6d-ad15-dc9a558431ab");
  });

  it("puts US on its own process", () => {
    expect(processForRegion("US")?.processId).toBe("26ab3a1e-ff20-406d-a0b4-3b351955da45");
  });

  it("returns null for a region nobody has mapped", () => {
    // A fourth region would otherwise land in AU's pipeline silently.
    expect(processForRegion("NZ")).toBeNull();
  });
});

describe("sentStage and wonStage", () => {
  it("sends AU to Proposal and wins at Sales Fulfillment", () => {
    expect(sentStage("AU")).toMatchObject({ id: "5e3bb017-ab1a-468a-8d58-0f71d6df9cbf", probability: 40, number: 4 });
    expect(wonStage("AU")).toMatchObject({ id: "2fc8fb09-24bb-4b24-a97c-f5ceedb7b39c", probability: 100, number: 7 });
  });

  it("sends US to Engage and wins at Execute Fulfilment", () => {
    expect(sentStage("US")).toMatchObject({ id: "ddf43a76-f167-4268-9cce-4be315903729", probability: 40, number: 2 });
    expect(wonStage("US")).toMatchObject({ id: "6a03c159-b1fa-4fa9-9359-612c8e9e4369", probability: 100, number: 5 });
  });
});

describe("shouldMoveStage", () => {
  it("moves a new opportunity to the target", () => {
    expect(shouldMoveStage(null, sentStage("AU")!)).toBe(true);
  });

  it("moves forward", () => {
    // Presentation (3) -> Proposal (4)
    expect(shouldMoveStage({ number: 3 }, sentStage("AU")!)).toBe(true);
  });

  it("refuses to move backwards", () => {
    // Already at Negotiation (5). A later quote must not pull the deal back to
    // Proposal (4): "this deal reached negotiation" stays true, and moving
    // somebody else's opportunity backwards is what destroys confidence in
    // the pipeline numbers.
    expect(shouldMoveStage({ number: 5 }, sentStage("AU")!)).toBe(false);
  });

  it("does nothing when already there", () => {
    expect(shouldMoveStage({ number: 4 }, sentStage("AU")!)).toBe(false);
  });

  it("compares by number, never by probability", () => {
    // The legacy process has thirteen stages all at 0%, so probability ties
    // and cannot order anything.
    expect(shouldMoveStage({ number: 12, probability: 0 }, { ...sentStage("AU")!, probability: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/act-opportunity-stages.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/act/opportunity-stages'`

- [ ] **Step 3: Implement**

Create the module. Shape it as a frozen table keyed by `Region.code`, with the four stage records carrying `id`, `name`, `probability` and `number` exactly as `RAW/ACT/meta/opp_stages.json` reports them.

The header comment must record three things, because each is a decision a future reader would otherwise reopen:

- These uuids live in Act! and are **transcribed here**. Nothing in the app can read a process definition at build time, so if an administrator edits a stage this table is what goes stale. Name `/api/opportunities/processes/{processId}/stages` as the command that re-reads them.
- **UK shares AU's process** by decision, not by accident, and the alternative — a UK process created inside Act! — would make this entry wrong rather than incomplete.
- **`number` orders stages, not `probability`.** Give the legacy-process reason.

`processForRegion` returns null for an unknown code rather than defaulting. A fourth region appearing in `REGIONS` must surface as a blocked outbox row that names itself, not as a British deal quietly joining the Australian pipeline.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/act-opportunity-stages.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/opportunity-stages.ts tests/act-opportunity-stages.test.ts
git commit -m "act: which process and stage a quote's region maps to

Stage ids transcribed from Act!, because nothing in the app can read a
process definition and a wrong uuid would fail deep inside a queued write.

Ordering is by the stage's own number, not its probability: the legacy
process carries thirteen stages all at zero percent, so probability ties and
cannot order anything.

An unmapped region returns null rather than falling back. A fourth region in
REGIONS should surface as a blocked row naming itself, not as a British deal
joining the Australian pipeline without anybody noticing."
```

---

### Task 2: The payloads, and the currency problem

**Files:** create `src/lib/act/write-payloads.ts`, `tests/act-write-payloads.test.ts`

**The problem to solve first.** An Act! Opportunity has **no currency field** — `productTotal`, `weightedTotal`, `totalPerContact` and `grossMargin` are bare numbers. PathQuote quotes exist in AUD, USD and GBP, and there is no FX anywhere in the schema.

So the currency has to be carried where a human will read it, and the number has to go in `productTotal` regardless. The decision: **put the currency and the amount in the opportunity's `name`** — `Q-AU-2026-014 — AUD 45,000.00` — and state it again in the History `details`. The name is what appears in every Act! list, so a mixed-currency pipeline is at least legible one row at a time.

**Say plainly in the module comment what this does not fix:** Act!'s own pipeline analytics (`/api/opportunity/analytics/*`) will sum `productTotal` across currencies and produce a number that means nothing. That is a limitation to document, not to paper over — and it is the same reason `docs/specs/2026-10-12-quote-outcomes-and-reporting-backlog.md` §4 keeps PathQuote's own value charts per-currency.

- [ ] **Step 1: Write the failing test**

Cover, with one `it` each:

- A History body for a finalised quote: `historyTypeID` is 62, `regarding` names the quote number, `details` carries the total **with its currency**, the validity and the revision, `startTime` is the finalise time, `contacts[]` holds exactly the contact's uuid, `recordManagerID` is the author's mapped ACT! user.
- The same with the author **unmapped**: `recordManagerID` falls back to the service account id, and nothing in the body pretends otherwise.
- An Opportunity body: `name` contains the number, the currency code and the formatted total; `stage` is the region's sent stage; `probability` matches that stage; `status` is `"Open"`; `openDate` is the finalise time; `contacts[]` has the contact.
- An Opportunity body for a quote whose company **has** an `actCompanyId`: `companies[]` has it.
- The same where it does not: `companies[]` is absent or empty, and the body is still valid.
- A won update: `status` becomes `"Closed-Won"`, `stage` is the won stage, `actualCloseDate` is set.
- A lost update: `status` becomes `"Closed-Lost"`, `reason` carries the recorded reason, and **the stage is left alone** — a lost deal does not advance.
- Money formatting: a `Decimal` total renders with two decimals and thousands separators, and `12345.6` renders `12,345.60`, not `12345.6`.

Read how `src/lib/format.ts` formats money and **use it** rather than writing a second formatter; check whether its `en-AU` default is right for a USD or GBP quote before you depend on it, and say what you found.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

Pure functions taking plain inputs — number, region code, totals, currency, the contact's and company's ACT! ids, the record manager id, dates — and returning the bodies. **No Prisma types in the signatures**: the caller maps rows to arguments. That is what keeps this testable with `isolate: false`.

- [ ] **Step 4: Verify** — all tests pass; `npm run typecheck`, `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/write-payloads.ts tests/act-write-payloads.test.ts
git commit -m "act: the History and Opportunity bodies a finalised quote produces

An Act! opportunity has no currency field -- productTotal and its siblings
are bare numbers -- and PathQuote quotes exist in three currencies with no
FX in the schema. So the currency goes in the opportunity's name, where every
Act! list shows it, and again in the history details.

What that does not fix, and the comment says so: Act!'s own pipeline
analytics will sum productTotal across currencies and produce a number that
means nothing. Documented rather than papered over."
```

---

### Task 3: What a queued row still needs

**Files:** create `src/lib/act/outbox-plan.ts`, `tests/act-outbox-plan.test.ts`

The decision module for the drain: given a row and the current state of its quote, what is the next step, is it finished, or is it blocked and why?

- [ ] **Step 1: Write the failing test**

Cases, one `it` each:

- Nothing done yet, contact already in ACT! → next step is the opportunity.
- Nothing done yet, contact **not** in ACT! → next step is creating the contact.
- Contact done, no opportunity → next step is the opportunity.
- Opportunity done, no history → next step is the history.
- All three done → finished, nothing to do.
- **Blocked: the quote has no contact at all.** `Document.contactId` is nullable and there is no primary-contact fallback, so a FINAL quote can legally carry a company and no contact. An Act! opportunity needs somebody to hang off. The reason must be a sentence a manager can act on, not an error code.
- **Blocked: the region is unmapped** (Task 1 returned null).
- **Blocked: the contact has no name** — Act! needs something to create.
- Re-running a finished row is a no-op, and re-running a partly-done row resumes rather than repeating. **This is the property the whole design rests on**: every step is idempotent because its result is stored before the next begins.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement**

A discriminated union — `{ kind: "create-contact" | "create-opportunity" | "update-opportunity" | "write-history" }`, `{ kind: "done" }`, `{ kind: "blocked", reason: string }`.

The blocked reasons are read by a manager on the quote, so write them as sentences. "This quote has no contact, so there is nobody in ACT! to attach it to — add a contact and finalise again" is useful; `NO_CONTACT` is not.

- [ ] **Step 4: Verify** — tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/outbox-plan.ts tests/act-outbox-plan.test.ts
git commit -m "act: what a queued write still needs, and when it cannot proceed

Every step stores its result before the next begins, so a row that fails
halfway resumes instead of repeating -- which is the whole of this design's
idempotency and the reason the steps are a sequence rather than one call.

Blocked reasons are sentences, because a manager reads them on the quote.
A quote with no contact is the common one: Document.contactId is nullable
with no primary-contact fallback, so a FINAL quote can legally carry a
company and nobody to attach an opportunity to."
```

---

### Task 4: The schema

**Files:** modify `prisma/schema.prisma`; create `prisma/migrations/z65_act_outbox/migration.sql`

- [ ] **Step 1: Add the model and the two columns**

`ActOutbox`: the kind of work, the `documentId` it concerns, attempt count, `lastError`, `nextAttemptAt`, `completedAt`, `blockedReason`, timestamps. Index what the drain queries — unfinished rows in attempt order.

`Document.actOpportunityId String?` and `QuoteRevision.actHistoryId String?`. Both store **ACT!'s** ids, which is what makes the steps idempotent.

Doc-comment each one in this schema's established voice, and record **why the ids live here rather than as a PathQuote id stamped into an ACT! custom field**: the five `PQ ` custom fields do not exist yet and creating them needs `Define Fields`, which the service account deliberately does not have, so that path is blocked on an administrator — and "which ACT! record did I create for this quote" is PathQuote's own fact to keep anyway.

Check the real next migration number before naming the directory; `z64` was taken by `actSyncVisible`.

- [ ] **Step 2: Verify the migration reproduces the schema**

This is what CI checks and what fails on the VPS if it is wrong. Read `.github/workflows/deploy.yml`'s `ci` job for the exact command it runs and run that one. Generate the `ALTER`/`CREATE` statements with `prisma migrate diff --script` rather than typing them, then add any data statements by hand.

Expected: no difference detected.

- [ ] **Step 3: Commit**

---

### Task 5: Teaching the client to write

**Files:** modify `src/lib/act/client.ts`

Today it is strictly read-only: `system()` and `contactsEditedSince()`, and the private `send()` takes `(label, url, headers)` — no method, no body — so it cannot POST at all.

- [ ] **Step 1: Widen the request path**

Give the internal helper a method and an optional JSON body, leaving every existing call site reading exactly as it does now. Keep the existing rules: retry network errors, timeouts and 5xx; **never retry 4xx**; one re-authorise on 401.

**Then think about retrying a write and say what you concluded.** Retrying a GET is free. Retrying a `POST /api/History` after a timeout can create a second history record, because the first may have succeeded with the response lost. The outbox stores each id before the next step, so a retry *between* steps is safe — but a retry *inside* one is not. State in the comment whether writes retry, and if they do not, why the outbox's own `nextAttemptAt` is the better place for it.

- [ ] **Step 2: Add the methods**

`createHistory`, `createOpportunity`, `updateOpportunity`, `getOpportunity`, `createContact`, `getContact`. Each returns the created or fetched record — `POST /api/contacts` returns the whole contact, not an id string, and the opportunity POST behaves the same way, which the next task needs for echo suppression.

For `updateOpportunity`, respect the two traps proven by `scripts/act-fix-country-*.py`: **`id` must be in the body as well as the path**, and a nested object must be written whole or its siblings are blanked. So read the opportunity, change the fields, write the whole object back.

- [ ] **Step 3: Verify** — `npm run typecheck`, `npm run lint`, `npm test` all clean, with no new tests (this is I/O; the architecture rule keeps it untested, and `isolate: false` forbids the mocks that would be needed).

- [ ] **Step 4: Commit**

---

### Task 6: Enqueue at finalise

**Files:** modify `src/lib/actions/finalize.ts`

**Why finalise and not send.** Not every manager sends through PathQuote — some download the PDF and email it themselves, so hooking the send would miss them entirely. `Finalize` is one unambiguous point, and for those managers it *is* the send. Decided 2026-10-12; the reasoning is in the spec §10a.

- [ ] **Step 1: Enqueue inside the finalise transaction**

Read `finalizeDocument` first and find the transaction that allocates `Document.number` and creates the `QuoteRevision`. The outbox row goes in there, so a finalise either records its intent or does not happen.

Note `planRevision`: a re-finalise with an unchanged snapshot hash **creates no revision and keeps the number**. So enqueueing must be idempotent against that — one unfinished row per document, not one per finalise click. Decide whether that is a unique index or a check, and say which and why.

- [ ] **Step 2: Attempt the drain immediately, off the request path**

Use `after()` from `next/server` — `src/lib/actions/signing-client.ts` already uses it for completion emails, so the pattern is established. Best-effort: a failure leaves the row for the nightly drain and must **never** fail the finalise. Finalising a quote cannot depend on a CRM being reachable.

- [ ] **Step 3: Verify** — `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

- [ ] **Step 4: Commit**

---

### Task 7: The drain

**Files:** create `src/lib/act/outbox.ts`

- [ ] **Step 1: Write the worker**

One row at a time: ask `outbox-plan.ts` for the next step, do it, store the resulting ACT! id, repeat until done or blocked. Record `lastError` and set `nextAttemptAt` with a backoff on failure.

**Echo suppression, and it is not optional.** Every ACT! write bumps `edited`, which **is** the inbound sync's cursor — so a write-back makes the next sync re-read what it touched, and write → read-back → write is a loop. After each successful write, store the returned record as the new `ActSnapshot` and update `actSourceEditedAt`. The record still appears in the next delta, because the filter is `edited ge`, but it no longer *looks* like a remote change.

**Create a contact only where one is genuinely missing**, keyed on `Contact.actContactId` being null. And store the created id immediately: a second attempt after a lost response must not create a duplicate person.

- [ ] **Step 2: Decide and document the concurrency**

The nightly drain and a finalise-triggered drain can coincide. Reuse the pattern phase 1 settled: a Postgres advisory lock, non-blocking, **with its own key** — `SYNC_LOCK_KEY`'s comment says a second feature wanting a lock must pick a different number, so pick one and record it the same way. Read `src/lib/act/sync.ts`'s lock to see why it uses a dedicated single-connection client released by `$disconnect()`, and whether that applies here.

- [ ] **Step 3: Verify** — the four commands.

- [ ] **Step 4: Commit**

---

### Task 8: Drain before the inbound read

**Files:** modify `src/lib/act/sync.ts`

- [ ] **Step 1: Call the drain at the start of a run**

Ordering is the point, not incidental: **writes land first, so the inbound read that follows sees them and records them as our own echo** rather than as a dozen remote changes. Put it after the lock is taken and before the cursor is read.

A dry run drains nothing. Neither does a run that lost the lock race.

Decide what a drain failure does to the run: the inbound sync is useful even when ACT! refuses a write, so a failed drain should be counted and reported rather than ending the run. Add the counts to `SyncResult` and to the CLI report, and extend `describeRun` so the Settings page says it — remembering that page is read by the director and now by managers with the `actSyncVisible` tick.

**Requirement (a), from the Task 7 review: the run holds the drain's lock too, for the whole run.** A run that drains holds **both** advisory keys — `8_472_001` (`SYNC_LOCK_KEY`) and `8_472_002` (`DRAIN_LOCK_KEY`) — on its own lock connection from before the drain until after the inbound read, and drains **under the held lock**: `drainActOutbox(client, { lockHeldOn: <that connection> })`. Without the option the drain tries to take `8_472_002` on a connection of its own, finds the sync holding it, and drains nothing (`busy`); with it, the drain checks in `pg_locks` that the connection really holds the key and throws if not. Holding only `8_472_001` leaves a fast-path drain free to POST a contact between the run's drain and its read; the read then imports that ACT! person as a second PathQuote contact before the drain stores the id, the drain's store hits `Contact_actContactId_key`, and the contact is held for a person with two PathQuote rows to merge. **Wait for `8_472_002` (`pg_advisory_lock`), do not skip**, when a fast path holds it at 03:00: a fast path's pass is over within about 10 minutes at worst (`DRAIN_TIME_BUDGET_MS`, 5 minutes, plus the step in flight when it runs out). Take it with `$executeRaw`, not `$queryRaw`: `pg_advisory_lock` returns `void`, which the pg adapter cannot read back (tried: `P2010`, "Failed to deserialize column of type 'void'"). The same requirement is written at `SYNC_LOCK_KEY` in `src/lib/act/sync.ts` and in the header of `src/lib/act/drain.ts`.

**Requirement (b): a periodic drain every 15 minutes**, over every due row — a systemd timer in the `tools` container, beside the nightly sync's units. Until it exists the only passes are the fast paths after a finalise, a signature or an acceptance, each over one quote, so a row that failed is retried only at its own quote's next event, and a contact released by hand (the FOR TASK 10 block in `src/lib/act/outbox-plan.ts`) unblocks each of its quotes only at that quote's next event. The drain's comments already describe this timer as Task 8's: the backoff schedule (`backoffMs` in `src/lib/act/drain-rules.ts`), the 5-minute time budget (a third of the 15), and `RECHECKS_PER_PASS` (10 a pass, so 40 lookup-blocked rows are each asked about once an hour). It takes `DRAIN_LOCK_KEY` itself, non-blocking: a pass that finds the nightly run or a fast path at work skips to the next tick.

- [ ] **Step 2: Verify** — the four commands, plus the new `describeRun` cases tested.

- [ ] **Step 3: Commit**

---

### Task 9: Show it on the quote

**Files:** modify the quote view under `src/components/documents/`

- [ ] **Step 1: Surface the row's state**

A manager who finalised a quote and sees nothing in ACT! must be able to find out why without reading a log. Three states to show: waiting, blocked with its reason, done.

Put the wording in a pure module with tests, as `src/lib/act/sync-view.ts` does for the Settings page — and read that file first for the voice. The audience is the same.

Note the one visible consequence of the design: a quote finalised at 11:00 whose write failed is not in ACT! until the nightly drain. Say that, rather than leaving it to be discovered.

- [ ] **Step 2: Verify** — the four commands including `npm run build`.

- [ ] **Step 3: Commit**

---

### Task 10: The runbook

**Files:** modify `docs/runbook.md`

- [ ] **Step 1: A §4d beside the sync section**

Follow §4c's shape exactly. Cover: that writes are queued and drained rather than immediate; how to see the queue; how to retry or clear a blocked row; that the service account is `Marketing` with role Manager, confirmed 2026-10-12, and that `Browse` would surface as a `403` inside a queued write rather than at startup; that the stage uuids in `opportunity-stages.ts` are transcribed from ACT! and go stale if an administrator edits a process, with the command that re-reads them; and that writes replicate to twelve laptops, which is why the nightly drain runs at 03:00.

- [ ] **Step 2: Commit**

---

## Addendum 2026-10-12 — a won quote makes the contact a Customer

Requested by Vadym during execution: when a quote is won, the ACT! contact moves from **Prospect** to **Customer**.

**The field.** `idStatus`, display name "ID/Status", `Character`, not read-only, picklist "Contact ID/Status" with **`isLimitToList: true`**, single select (`RAW/ACT/meta/fields_contact.json`, a local capture). `Customer` and `Prospect` are both legal values — the inbound sync's `ACTIVE_STATUSES` filters on exactly those two.

**The triggers.**

- **Contact → Customer: on a standing signature** (`signingStatus` `SIGNED`, set by `completeSigning`, `src/lib/actions/signing-client.ts`) — Vadym: "the contact signed the quote". Acceptance is not a trigger of its own: `acceptQuote` requires the signature, so it only ever added the case after `voidSignature`, which leaves `acceptedAt` set — and promoting then would make a customer of a corrected contact who has signed nothing.
- **Opportunity → Won: when the quote is accepted with a standing signature** (`acceptedAt` set **and** `SIGNED`), per spec §10 D3. A quote voided after acceptance is not won until the client signs again, and then at the signed figure. `wonOpportunityBody` from Task 2 finally gets a caller here.
- **A Won deal's product line shows the latest signed figure:** a revision re-finalised after a void leaves it alone; the client's signature on that revision writes it.
- **Later:** the manual WON outcome from `docs/specs/2026-10-12-quote-outcomes-and-reporting-backlog.md` becomes a further trigger for both. Not in this plan.

**Rules.**

- **Forward only.** Customer never goes back to Prospect — not on `voidSignature`, not on unfinalise. Same reasoning as the stage rule: "this became a customer" stays true.
- **Change only what we own.** Promote only when the contact's **current** ACT! value is `Prospect` — trimmed, then compared case for case, exactly as the inbound sync reads it. Anything else — already `Customer`, a reseller or supplier status, blank — is left alone and the step counts as done. The drain reads the current value with a GET; a pure function decides. Overwriting a status somebody set deliberately is the harm this rule prevents.
- **Echo suppression applies.** The promotion bumps the contact's `edited`, so the drain stores the returned record as the contact's `ActSnapshot`, exactly as for creates.

**How it fits the outbox.** These are new events on a document whose finalise row may already be complete. `completeSigning` and `acceptQuote` enqueue the same way finalise does — insert, or take over the unfinished row via the z65 partial index. The planner gains two steps, `promote-contact` and `win-opportunity`, which come **after** `write-history` and are checked **before** returning `done`, so a row created by a signing event does not short-circuit to `done` just because its revision's history was already written.

**Progress storage.** The planner is pure and cannot GET, so each step needs a stored fact that it has happened: `Document.actContactPromotedForId` and `Document.actOpportunityWonAt`, both on the document. The win is once per deal. Promotion is once per **contact** per deal — `voidSignature` exists for a wrong signatory, and a corrected contact who signs is due its own promotion — so the fact is the ACT! id of the contact promoted, compared with the quote's contact as it stands (a bare id, no foreign key, so it outlives a deleted or merged PathQuote contact). These belong in z65, which has not been applied anywhere outside scratch databases; amend it rather than adding z66, and re-run the drift verification.

**A Lost opportunity — decided by Vadym, 2026-10-12:** *"Overwrite to Won — PathQuote confirms. If after that someone changes it to Lost by hand in ACT!, it stays that way."* Acceptance patches any opportunity that is not already Won (Lost, Inactive, anything else) to Won, moving the stage forward to the won stage where the forward-only rule allows. The second sentence holds because `actOpportunityWonAt` is never cleared: once set, the planner never plans the win again.

**Creating a contact.** `newContactBody` sends `idStatus: Prospect` — left blank, the contact would be skipped by the inbound sync and never promoted — plus the name, email, business phone, title, free-text company and, only when the author has one, Account Mgr.

## Addendum 2026-10-13 — the amount in ACT! is before tax

Decided by Vadym: the amount PathQuote writes to ACT! **excludes tax**. AU quotes carry GST and UK quotes VAT, while an export quote carries none, so tax-inclusive amounts make the ACT! pipeline incomparable from one region to the next; before tax is the usual pipeline base and means the same in every region. This supersedes "the total" wherever the tasks above put an amount into ACT! (the History `details`, the product line).

- **The figure** is the revision's total less its tax: `QuoteRevision.total` minus the frozen snapshot's `totals.taxAmount` (`revisionAmount` in `src/lib/act/drain-rules.ts`). **Not** the snapshot's `totals.subtotal`, which the decision was first put in terms of: the pricing engine's `subtotal` is before the document-level discount (`taxableBase = subtotal - discountAmount`, `total = taxableBase + taxAmount`, `computeTotals` in `src/lib/pricing.ts`), so on a discounted quote it overstates what the client pays before tax. Never the live Document — the frozen revision only, as everything else in a body.
- **Where it goes:** the product line's `price`, `discountPrice` and `total`, and its name, which now says what the number is: `Q-AU-2026-014-R2 — AUD 45,000.00 ex GST`, the tax named from the snapshot's `taxName` (GST, VAT, Sales Tax, or a Custom quote's own; "ex tax" if a snapshot had none). The History's `details` lead with `Amount: AUD 45,000.00 ex GST`, then `Total incl. GST: AUD 49,500.00` for reference — or, when no tax was charged, `Total: USD 30,000.00, no Sales Tax charged`. The opportunity's name is unchanged: number and currency code only.
- **A revision whose snapshot has no readable `totals.taxAmount` is held** (`blockedBy = "revision"`), as one with no validity is — never written at its tax-inclusive total instead. Every snapshot finalise and `scripts/backfill-quote-revisions.ts` have written carries one, in version 1 and 2 alike, so this guards against a revision no finalise produced.
- **The quote's ACT! card** shows the line's amount the same way, before tax and named so.

## Obligations carried into Tasks 6 and 7 from the Task 4 review

- **Every row write by the drain is conditional:** `WHERE id = $1 AND "quoteRevisionId" = $planned AND "completedAt" IS NULL`. A take-over between planning and writing must not be clobbered — completing, storing `opportunityActId`, setting `blockedReason` or backing off would otherwise land on a row that now means a different revision. If that conditional update matches 0 rows after an opportunity **create**, `Document.actOpportunityId` must still be committed, or the next pass creates a second opportunity.
- **No row lock held across ACT! calls** — that would make finalise wait on the CRM.
- **Blocked rows are re-planned on every pass.** The due index excludes them, and the fixes the blocked reasons tell a manager to make (name a contact, map a region) involve no re-finalise. If `nextStep` no longer returns `blocked`, clear `blockedReason` and make the row due. No ACT! calls needed; unfinished rows are few.
- **Time zones.** `nextAttemptAt` is `timestamp(3)` without zone, filled with UTC by Prisma. Comparing it to SQL `now()` is only right if the session zone is UTC, which the repo does not pin. Pass a JS `Date` as a parameter instead.
- **Take-over must also reset `attempts` and clear `lastError`**, or Task 9's UI shows a stale error beside a fresh row.
- **A raw take-over `INSERT` must supply `id` and `updatedAt`** — neither has a database default — and Prisma's `upsert` cannot target a partial index, so Task 6 uses `$executeRaw`.
- **Superseded revisions.** If revision N's row is taken over before N's History is written, ACT! never records N. Because finalise *is* the send for managers who email the PDF themselves, N may have reached the customer. Accepted for now — the alternative is one row per revision, which reintroduces two live rows per deal — but `actHistoryId` lives on the revision, so a later planner could journal every un-journaled revision of a document with no migration. Record this in the planner's comments.

## Verification that cannot be done from a laptop

The API is IP-allowlisted to the VPS, so the first real write happens there. Before trusting it:

- [ ] Finalise a **test** quote and confirm one History and one Opportunity appear on the right contact, with the right stage, owner and currency in the name.
- [ ] Finalise it again with no changes — confirm **no** second history and **no** second opportunity.
- [ ] Confirm the next inbound sync does **not** report the touched records as changes. This is echo suppression, and it is the one thing no unit test can prove.
- [ ] Finalise a quote whose contact exists only in PathQuote — confirm the contact is created, and that `actContactId` is stored.
- [ ] Finalise a quote with no contact — confirm the quote shows the blocked reason rather than failing silently.
- [ ] Stop the ACT! API (or point `ACT_BASE` at a closed port) and finalise — confirm the quote still finalises, the row queues, and the nightly drain picks it up.
- [ ] Have a test client sign a quote whose contact is a Prospect — confirm the contact becomes Customer in ACT!, and that a contact with any other status is left untouched.
- [ ] Accept that quote — confirm the opportunity goes to Won at the 100% stage, and that a second accept writes nothing.
- [ ] Accept a quote whose opportunity was marked Lost in ACT! — confirm it goes to Won; then mark it Lost again by hand and confirm a later revision or a second accept leaves it Lost.
- [ ] Finalise a quote whose contact exists only in PathQuote — confirm ACT! stores the new contact as a Prospect with the phone as sent, and accepts a create with no country.
