# Scheduled ACT! sync and a Sync now button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ACT! sync runs by itself every night, and an admin can run it on demand from Settings and see what the last run did.

**Architecture:** A systemd timer on the VPS runs the existing `act:sync` CLI, modelled on `pq-backup-db.timer`, in the same timezone, an hour ahead of it, and reusing its failure-email unit. The same worker gains two things both callers need: a Postgres advisory lock, so the timer and the button can never run at once, and a record of each run in `Setting` so the UI has something to show. The button is an admin-only server action that runs a delta sync inline — a day's edits, not the whole base.

**Tech Stack:** systemd timers, Docker Compose, Next.js server actions, Prisma/Postgres, vitest.

**Context:** Phase 1 is live in production — 8,809 companies and 10,471 contacts imported 2026-10-08. The sync currently runs only when Vadym types the command, which is the gap this closes. See `docs/superpowers/plans/2026-10-07-act-sync-phase-1.md` and `docs/act-integration-reference.md` §10.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/act/run-record.ts` | create — the shape of a recorded run and the pure wording the UI shows |
| `src/lib/act/sync.ts` | modify — take the advisory lock, record the run |
| `src/lib/queries/act-sync.ts` | create — read the last run for the page |
| `src/lib/actions/act-sync.ts` | create — the admin-only "Sync now" action |
| `src/app/(app)/settings/act-sync/page.tsx` | create — the Settings section |
| `src/components/settings/act-sync-panel.tsx` | create — the button and the last-run summary |
| `src/lib/settings-nav.ts` | modify — one nav entry |
| `scripts/ops/pq-act-sync.sh` | create — what the timer runs |
| `scripts/ops/pq-act-sync.service` | create — oneshot unit, with the failure alert |
| `scripts/ops/pq-act-sync.timer` | create — nightly, 03:00 America/New_York |
| `docs/runbook.md` | modify — a section beside Backups |
| `tests/act-run-record.test.ts` | create |

`sync.ts` stays an I/O shell: the lock and the write are mechanical, and everything with a decision in it goes in `run-record.ts` where it is tested.

---

### Task 1: Only one sync at a time

**Files:**
- Modify: `src/lib/act/sync.ts`

Two callers now exist — the timer and the button — and nothing stops them overlapping. The phase-1 review flagged this and deferred it with the words "it becomes one when the Sync-now button or the nightly job lands". It has landed.

Two concurrent runs cannot duplicate rows, because `actContactId` and `actCompanyKey` are unique and the loser throws `P2002`. What they can do is waste ten minutes each and leave the cursor wherever the slower one finished. A lock is cheaper than reasoning about that.

- [ ] **Step 1: Take an advisory lock around the run**

In `src/lib/act/sync.ts`, at the top with the other constants:

```typescript
/**
 * The lock two syncs contend for. A Postgres advisory lock rather than a row:
 * it is released when the connection closes, so a crashed or killed run
 * cannot wedge the next one, which a `locked = true` row absolutely can.
 *
 * The number is arbitrary and only has to stay fixed. It is recorded here and
 * nowhere else, so a second feature wanting a lock must pick a different one.
 */
const SYNC_LOCK_KEY = 8_472_001;
```

Then wrap the body of `syncContacts`. The shape:

```typescript
  const [{ locked }] = await db.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${SYNC_LOCK_KEY}) AS locked
  `;
  if (!locked) {
    throw new SyncAlreadyRunningError();
  }
  try {
    // ... the existing body, unchanged ...
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(${SYNC_LOCK_KEY})`;
  }
```

And the error type, exported so the action and the CLI can both recognise it rather than matching on a message:

```typescript
/** Thrown when another sync holds the lock. Not a failure of this run: the
 * work is already being done by somebody else. */
export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A sync is already running. Wait for it to finish and try again.");
    this.name = "SyncAlreadyRunningError";
  }
}
```

**`pg_try_advisory_lock`, not `pg_advisory_lock`.** The blocking form would queue the button behind a ten-minute import and leave the admin staring at a spinner with no way to tell. Failing immediately lets the caller say so.

Note for whoever implements this: Prisma's connection pool means the unlock must run on the same connection as the lock. With `$queryRaw` on a pooled client that is not guaranteed. **Check this.** If it is not reliable, use `db.$transaction` around the whole run so both statements share one connection, and say in the report which you did and why.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/act/sync.ts
git commit -m "sync: refuse to run while another sync holds the lock

A nightly timer and a Sync now button are both about to exist, and nothing
stopped them overlapping. Two runs cannot duplicate rows -- the unique indexes
see to that, and the loser throws P2002 -- but they can each waste ten minutes
and leave the cursor wherever the slower one happened to finish.

An advisory lock rather than a row, because it is released when the connection
closes: a killed run cannot wedge the next one, which a locked = true column
absolutely can. And the non-blocking form, so the button can say someone else
is already syncing instead of queueing behind a full import."
```

---

### Task 2: Remember what the last run did

**Files:**
- Create: `src/lib/act/run-record.ts`
- Test: `tests/act-run-record.test.ts`

The page has to show something between runs, and "it worked" is not enough — the useful questions are *when*, *how many*, and *did anything fail*.

- [ ] **Step 1: Write the failing test**

Create `tests/act-run-record.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { describeRun, type ActSyncRun } from "../src/lib/act/run-record";

function run(overrides: Partial<ActSyncRun> = {}): ActSyncRun {
  return {
    startedAt: "2026-10-09T07:00:00.000Z",
    finishedAt: "2026-10-09T07:00:42.000Z",
    trigger: "schedule",
    contactsCreated: 3,
    contactsUpdated: 11,
    companiesCreated: 2,
    companiesFromNamelessContacts: 0,
    companiesKeyCollisions: 0,
    failed: 0,
    error: null,
    ...overrides,
  };
}

describe("describeRun", () => {
  it("summarises a clean run by what changed", () => {
    expect(describeRun(run())).toMatchObject({
      tone: "ok",
      headline: "3 contacts added, 11 updated, 2 companies added",
    });
  });

  it("says so plainly when a run changed nothing", () => {
    // The common case once the nightly job is running: nobody edited ACT!
    // yesterday. "0 contacts added, 0 updated" reads like a fault.
    expect(
      describeRun(run({ contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0 })),
    ).toMatchObject({ tone: "ok", headline: "No changes" });
  });

  it("leads with the failure when one contact failed", () => {
    const described = describeRun(run({ failed: 2 }));
    expect(described.tone).toBe("error");
    expect(described.headline).toContain("2 contacts failed");
  });

  it("leads with the error when the run never finished", () => {
    const described = describeRun(run({ finishedAt: null, error: "authorize failed (401)" }));
    expect(described.tone).toBe("error");
    expect(described.headline).toContain("authorize failed (401)");
  });

  it("flags a key collision even on an otherwise clean run", () => {
    // Two different firms whose names normalise alike. Nothing is broken, but
    // a person should look, and nothing else on the page would say so.
    const described = describeRun(run({ companiesKeyCollisions: 1 }));
    expect(described.tone).toBe("warn");
    expect(described.detail).toContain("1 company key collision");
  });

  it("names the companies imported without a contact", () => {
    expect(describeRun(run({ companiesFromNamelessContacts: 4 })).detail).toContain(
      "4 companies had no named contact",
    );
  });

  it("says which trigger started it", () => {
    expect(describeRun(run({ trigger: "manual" })).trigger).toBe("Run by hand");
    expect(describeRun(run({ trigger: "schedule" })).trigger).toBe("Scheduled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/act-run-record.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/act/run-record"`

- [ ] **Step 3: Write the implementation**

Create `src/lib/act/run-record.ts`:

```typescript
// What one sync run leaves behind, and how the Settings page says it.
//
// Stored as JSON in the `Setting` row `act.sync.lastRun`. A row rather than a
// table because exactly one is ever wanted: the question the page answers is
// "did last night work", not "show me the history". A table would be a nicer
// answer to a question nobody has asked yet.
//
// Pure: no database, no React. The wording is the part worth testing, and the
// counts it reads come straight from SyncResult.

/** The Setting key the record lives under. */
export const LAST_RUN_KEY = "act.sync.lastRun";

export type SyncTrigger = "schedule" | "manual";

export type ActSyncRun = {
  startedAt: string;
  /** Null when the run threw: it started and never came back. */
  finishedAt: string | null;
  trigger: SyncTrigger;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  companiesFromNamelessContacts: number;
  companiesKeyCollisions: number;
  failed: number;
  /** The message, when the run threw. */
  error: string | null;
};

export type RunDescription = {
  tone: "ok" | "warn" | "error";
  /** One line: what happened. */
  headline: string;
  /** A second line for things worth a look, or null. */
  detail: string | null;
  /** "Scheduled" or "Run by hand". */
  trigger: string;
};

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;
}

/**
 * One run, in words.
 *
 * Three tones, and the middle one earns its place: a run that imported
 * everything cleanly but hit a company-key collision is not a failure and not
 * nothing. Two different firms whose names normalise alike need a person, and
 * no other screen would mention it.
 */
export function describeRun(run: ActSyncRun): RunDescription {
  const trigger = run.trigger === "manual" ? "Run by hand" : "Scheduled";

  if (run.error) {
    return { tone: "error", headline: `Failed: ${run.error}`, detail: null, trigger };
  }

  if (run.failed > 0) {
    return {
      tone: "error",
      headline: `${plural(run.failed, "contact", "contacts")} failed`,
      detail:
        "The cursor did not move, so nothing was skipped -- fix the cause and run it again.",
      trigger,
    };
  }

  const changes: string[] = [];
  if (run.contactsCreated > 0) changes.push(`${plural(run.contactsCreated, "contact", "contacts")} added`);
  if (run.contactsUpdated > 0) changes.push(`${run.contactsUpdated.toLocaleString("en-GB")} updated`);
  if (run.companiesCreated > 0) {
    changes.push(`${plural(run.companiesCreated, "company", "companies")} added`);
  }

  // The ordinary outcome once this runs nightly: nobody touched ACT! yesterday.
  // "0 contacts added, 0 updated" reads like something went wrong.
  const headline = changes.length > 0 ? changes.join(", ") : "No changes";

  const notes: string[] = [];
  if (run.companiesKeyCollisions > 0) {
    notes.push(
      `${plural(run.companiesKeyCollisions, "company key collision", "company key collisions")} -- two firms whose names normalise alike`,
    );
  }
  if (run.companiesFromNamelessContacts > 0) {
    notes.push(
      `${plural(run.companiesFromNamelessContacts, "company", "companies")} had no named contact`,
    );
  }

  return {
    tone: run.companiesKeyCollisions > 0 ? "warn" : "ok",
    headline,
    detail: notes.length > 0 ? notes.join(". ") : null,
    trigger,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/act-run-record.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/act/run-record.ts tests/act-run-record.test.ts
git commit -m "sync: the shape of a recorded run, and how to say it

One Setting row rather than a table: the question the page answers is 'did
last night work', not 'show me the history', and a table would be a nicer
answer to a question nobody has asked.

Three tones, and the middle one earns its place -- a run that imported cleanly
but hit a company-key collision is neither a failure nor nothing. Two firms
whose names normalise alike need a person to look, and no other screen in the
app would ever mention it.

'No changes' rather than '0 added, 0 updated', because once this runs nightly
that is the ordinary outcome and zeros read like a fault."
```

---

### Task 3: Write the record at the end of every run

**Files:**
- Modify: `src/lib/act/sync.ts`

- [ ] **Step 1: Record the run, however it ends — including when it never ends**

Write the record **twice**: once when the run starts, with `finishedAt: null`, and again when it finishes or throws.

That is not belt-and-braces, it is the only way one case can be told. A `kill -9`, an OOM, or a reboot mid-run runs no catch block. Write only at the end and such a run leaves no record at all, so the page shows last night's successful run as though it were current — a silent lie, and the worst answer this page can give. Writing at the start leaves a record saying the run began and never came back, which `describeRun` already has a branch for.

It also costs one extra upsert per run, against a run that takes minutes.

**The complication this creates, which must be handled here or the page lies the other way:** *during* a legitimate run the record also has `finishedAt: null`, so a page loaded mid-sync would say "Started and never finished" about a run that is going perfectly. The two states are distinguished by whether the advisory lock from Task 1 is currently held:

| `finishedAt` | lock held | what it means |
|---|---|---|
| set | — | finished; `describeRun` says how it went |
| null | yes | running right now |
| null | no | died without finishing |

So export a `isSyncRunning()` from `src/lib/act/sync.ts` that answers it:

```sql
SELECT EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory' AND objid = <the low half of SYNC_LOCK_KEY>
) AS running
```

Check how Postgres splits a single-argument advisory lock key across `classid`/`objid` before writing that predicate, and verify it against a real lock rather than reasoning about it — getting it wrong means either "running forever" or "never running", both of which look like the feature is broken.

Then give `describeRun` an optional second argument `{ running: boolean }`, defaulting to false, and gate its never-finished branch on it. The tests for that branch stay; add one for the running case.

`syncContacts` already returns a `SyncResult`. Capture `startedAt` before the work.

Add a `trigger: SyncTrigger` to `SyncOptions`, defaulting to `"manual"`, so the CLI and the action can label their runs. A dry run records nothing: it changed nothing, and overwriting the last real run's record with a rehearsal would be misleading.

The writer, next to `writeCursor`:

```typescript
async function writeRunRecord(run: ActSyncRun): Promise<void> {
  await db.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, value: run as unknown as Prisma.InputJsonValue },
    update: { value: run as unknown as Prisma.InputJsonValue },
  });
}
```

Catch, record, rethrow — the caller still needs to know it failed:

```typescript
  } catch (error) {
    if (!options.dryRun && !(error instanceof SyncAlreadyRunningError)) {
      await writeRunRecord({
        ...counters,
        startedAt,
        finishedAt: null,
        trigger: options.trigger ?? "manual",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
```

A `SyncAlreadyRunningError` writes nothing: this run did not happen, and the record belongs to the one that is actually running.

- [ ] **Step 2: Print it from the CLI too**

In `scripts/act-sync.ts`, pass `trigger` — the CLI gains a `--trigger=schedule` flag so the timer's runs are labelled, defaulting to `manual`. Validate it the way the other flags are validated: an unrecognised value exits 2 rather than being ignored.

- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/act/sync.ts scripts/act-sync.ts
git commit -m "sync: record every run, including the ones that fail

A run that threw is precisely the one somebody wants to see on the Settings
page, so the record is written from the failure path as well as the success
one, then the error is rethrown so the caller still knows.

A dry run records nothing -- it changed nothing, and overwriting last night's
real record with a rehearsal would be a lie. Nor does a run that found the
lock held: that run did not happen, and the record belongs to the one that is
actually running."
```

---

### Task 4: The systemd timer

**Files:**
- Create: `scripts/ops/pq-act-sync.sh`, `scripts/ops/pq-act-sync.service`, `scripts/ops/pq-act-sync.timer`

Model these on `scripts/ops/pq-backup-db.{service,timer}` and `scripts/ops/pq-backup.sh` — read all three first, including the `flock` at the top of the script.

- [ ] **Step 1: The script**

`scripts/ops/pq-act-sync.sh`, installed to `/usr/local/bin/`:

```bash
#!/bin/bash
#
# Nightly ACT! -> PathQuote sync. Run by pq-act-sync.timer.
#
# The delta is small on an ordinary night -- whatever changed in ACT! that day
# -- so this is minutes at most. The first run after a long outage re-reads
# more, and the worker checkpoints its cursor per page, so an interrupted run
# resumes rather than starting again.
#
set -euo pipefail

cd /opt/pathquote

# The image for the commit that is actually deployed. Without this, compose
# falls back to `latest`, which nothing refreshes -- every deploy pulls a
# SHA-pinned tag, so the local `latest` can be months stale. That exact trap
# cost an afternoon on 2026-10-08.
export TAG="$(git rev-parse HEAD)"

echo "$(date -Is) act:sync starting at $TAG"
docker compose run --rm tools npm run act:sync -- --trigger=schedule
echo "$(date -Is) act:sync ok"
```

No `flock` here: the lock lives in the worker (Task 1), where it also covers the Sync now button. A file lock would only cover the two things that happen on this box.

- [ ] **Step 2: The unit**

`scripts/ops/pq-act-sync.service`:

```ini
[Unit]
Description=PathQuote: nightly ACT! contact sync
After=docker.service network-online.target
Wants=network-online.target
OnFailure=pq-backup-alert@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pq-act-sync.sh
StandardOutput=append:/var/log/pq-act-sync.log
StandardError=append:/var/log/pq-act-sync.log
```

Check `scripts/ops/pq-backup-alert.sh` before relying on it: if its subject or body says "backup" rather than reading the unit name from `%i`, generalise the wording so an ACT! sync failure does not arrive calling itself a backup. Report what you found.

- [ ] **Step 3: The timer**

`scripts/ops/pq-act-sync.timer`:

```ini
[Unit]
Description=PathQuote: nightly ACT! contact sync

[Timer]
# 03:00 Australia/Melbourne -- the same zone pq-backup-db.timer uses, and one
# hour before it. Two reasons to keep one zone across the box rather than
# pinning this one to US Eastern: the night-time window stays a single window
# that an operator can hold in their head, and the ordering is deliberate --
# the sync lands first, so the 04:00 dump contains what it imported rather
# than yesterday's state.
#
# It is also after hours in Melbourne, where the Act! server itself sits on
# the office LAN, and 09:00-12:00 the previous day across the US, which is
# work time there but costs nothing: the sync only reads from Act! and the
# managers are working in Act!, not in PathQuote's imported copy.
#
# Named zone rather than UTC so the hour survives daylight saving, same as the
# backup timers.
OnCalendar=*-*-* 03:00:00 Australia/Melbourne
# A run missed while the VPS was down happens at next boot instead.
Persistent=true
# Up to five minutes of jitter, so the sync and anything else on the hour do
# not start in lockstep.
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Commit**

```bash
git add scripts/ops/pq-act-sync.sh scripts/ops/pq-act-sync.service scripts/ops/pq-act-sync.timer
git commit -m "ops: run the ACT! sync nightly

Until now it ran when Vadym typed the command, which means ACT! and PathQuote
drift the week he stops.

03:00 Australia/Melbourne: the zone the backup timers already use, one hour
before the 04:00 dump. One night-time window across the box is easier to hold
in your head than two, and the ordering is the point -- the sync lands first,
so the dump captures what it imported rather than yesterday's state. It is
also after hours in Melbourne, where the Act! server sits on the office LAN.

The script exports TAG from the deployed commit. Without it compose resolves
`latest`, which no deploy ever refreshes, so the box would quietly run a
months-old image -- that trap cost an afternoon on 2026-10-08."
```

---

### Task 5: Read the last run, and run one on demand

**Files:**
- Create: `src/lib/queries/act-sync.ts`, `src/lib/actions/act-sync.ts`

- [ ] **Step 1: The query**

`src/lib/queries/act-sync.ts` reads the `Setting` row and returns `ActSyncRun | null`. Parse defensively: the row is JSON written by an older version of this code one day, so a missing field should give null rather than throwing on the Settings page.

- [ ] **Step 2: The action**

`src/lib/actions/act-sync.ts`:

```typescript
"use server";
```

`requireAdmin()`, then `syncContacts(actClientFromEnv(), { trigger: "manual" })`, then `revalidatePath("/settings/act-sync")`. Return `{ error }` on `SyncAlreadyRunningError` with its message, rather than letting it bubble as a server error — "somebody else is syncing" is an answer, not a crash.

Three things this must not do:

- **No `--full`.** The button runs the delta. A full re-read of 17,529 contacts from a browser request is not something to offer behind one click; that stays on the CLI.
- **No credentials from the caller.** `actClientFromEnv()` reads the four `ACT_*` values the container already has.
- **No swallowing of other errors.** A 401 from ACT! should reach the page as a message and be recorded by Task 3.

Note the delta is normally seconds. A first click after a long outage could run minutes, and a server action gives no progress — say so in the UI copy rather than engineering a job queue for a case that should not recur once the timer is running.

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add src/lib/queries/act-sync.ts src/lib/actions/act-sync.ts
git commit -m "sync: read the last run, and let an admin start one

The button runs the delta, never --full: re-reading all 17,529 contacts from a
browser request is not something to put behind one click, and the CLI is still
there for it.

An already-running sync comes back as a message rather than a server error. It
is an answer -- somebody else is doing the work -- not a crash."
```

---

### Task 6: The Settings section

**Files:**
- Create: `src/app/(app)/settings/act-sync/page.tsx`, `src/components/settings/act-sync-panel.tsx`
- Modify: `src/lib/settings-nav.ts`

- [ ] **Step 1: The nav entry**

In `SETTINGS_NAV_ITEMS`, after Import / Export:

```typescript
  // Operational rather than administrative: nothing here is a list to curate,
  // it is a job that runs nightly and a button for when someone cannot wait.
  { href: "/settings/act-sync", label: "ACT! sync", icon: RefreshCw, adminOnly: true },
```

Import `RefreshCw` from `lucide-react`. Check `tests/` for a test over `SETTINGS_NAV_ITEMS` — if one asserts the list, update it.

- [ ] **Step 2: The page**

`requireAdminPage()`, read the last run, render a `SectionCard` per the pattern in `src/app/(app)/settings/users/[userId]/page.tsx`.

Two things carried forward from the Task 2 review, to settle on this page:

- The `failed` branch's detail still says "the cursor did not move". It is accurate there — `checkpoint()` bails once `failed > 0` — but "cursor" is developer vocabulary on a page written for the director, and the sentence loses nothing as "Nothing was skipped — fix the cause and run it again."
- With both notes firing, `detail` is three sentences. Render it as a paragraph, not a single clipped line.

It should answer, in this order: **when did it last run**, **what did it do**, **is anything wrong**, and **run it now**. Show the time as both absolute and relative ("2 hours ago") — relative answers "is this stale?" at a glance, absolute answers "was that before or after I edited the record?".

Also show the stored cursor, which is the ACT! `edited` timestamp the sync has reached. It is the one number that explains a surprising result, and reading it currently needs SQL.

- [ ] **Step 3: The panel**

Client component: a `Button variant="brand"` with `h-11`, `useTransition`, the toast on success and `role="alert"` on failure — the same shape as `src/components/settings/contacts-visibility-editor.tsx`.

While it runs, say what is happening rather than only spinning: "Reading ACT!…". Say in the surrounding copy that a run normally takes seconds and that the nightly job covers the usual case, so nobody presses it out of anxiety.

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run typecheck && npm run lint`

```bash
git add "src/app/(app)/settings/act-sync/page.tsx" src/components/settings/act-sync-panel.tsx src/lib/settings-nav.ts
git commit -m "settings: show the ACT! sync and let an admin run it

Its own section rather than a card on Account: it is operational, not a list
to curate, and the same argument Import / Export already won.

The page answers when it last ran, what it did, whether anything needs a
person, and offers the button. The stored cursor is on it too -- it is the one
number that explains a surprising result, and reading it needed SQL until now."
```

---

### Task 7: The runbook

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 1: A section beside Backups**

Follow the shape of §4 exactly — a table of unit, schedule, log and what it checks, then the commands, then the install lines. Cover:

- `systemctl list-timers 'pq-act-sync*'`, `systemctl start pq-act-sync.service`, `tail /var/log/pq-act-sync.log`
- that the failure email arrives through `pq-backup-alert@`, same as a backup failure
- the `scp` + `daemon-reload` + `enable --now` install lines
- that the four `ACT_*` values come from `/opt/pathquote/.env`, and that the API is IP-allowlisted to this VPS so it cannot be run from anywhere else
- that the Settings page shows the last run, so the first place to look is the browser, not the log
- **a wedged advisory lock.** The sync holds a Postgres session advisory lock for the length of a run, released by ending that session. A killed or crashed run closes its socket and loses the lock with it. A host that *vanishes* — power cut, hypervisor loss — sends no FIN, so Postgres keeps the session until its own `tcp_keepalives_idle` reaps it: **about 2h11m on the defaults** (7200s + 75s × 9). Nothing in the application can shorten that; the levers are `tcp_keepalives_idle` in `postgresql.conf`, which affects every session on the server, or an admin running `pg_terminate_backend` on the holder. Give the query that finds it:

```sql
SELECT pid, state, backend_start, query
FROM pg_stat_activity
WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory');
```

  The symptom is every run — nightly and button alike — reporting that a sync is already running when none is. Say plainly that this is the only state needing a manual unwedge, and that waiting the two hours also works.

- [ ] **Step 2: Commit**

```bash
git add docs/runbook.md
git commit -m "docs: how the nightly ACT! sync is run and checked"
```

---

### Task 8: Install it and watch it run

**Files:** none — this is the deployment.

- [ ] **Step 1: Deploy the code**

Push, let CI build, and confirm the Settings section appears at `/settings/act-sync`.

- [ ] **Step 2: Install the units**

```bash
scp -P 3498 scripts/ops/pq-act-sync.sh root@VPS:/usr/local/bin/
scp -P 3498 scripts/ops/pq-act-sync.service scripts/ops/pq-act-sync.timer root@VPS:/etc/systemd/system/
ssh -p 3498 root@VPS 'chmod 700 /usr/local/bin/pq-act-sync.sh && systemctl daemon-reload && systemctl enable --now pq-act-sync.timer'
```

- [ ] **Step 3: Run it once by hand, before trusting the timer**

```bash
systemctl start pq-act-sync.service
journalctl -u pq-act-sync -n 20 --no-pager
tail -20 /var/log/pq-act-sync.log
```

Expected: a delta run, `failed 0`, and the Settings page showing it within seconds.

- [ ] **Step 4: Prove the lock**

Start the service and press **Sync now** in the browser while it is running. The page must say a sync is already running, not start a second one. This is the one behaviour here that cannot be unit-tested, and it is the one that corrupts the cursor if it is wrong.

- [ ] **Step 4a: Measure the one number that is still a guess**

Task 5 worked out that the button's worst case is **~43 minutes** (88 pages × 200 contacts, each exchange bounded by 3 attempts × 30s + backoff), and that nothing in the application bounds it: `next.config.ts` declares no `serverActions` block, `maxDuration` means nothing behind a proxy, and Node's response timeout is off. The only ceiling is nginx's `proxy_read_timeout` — **assumed to be the 60s default, read from nginx's documentation rather than from this server**, because the live site is a WordOps proxy site whose generated template is not in this repo.

Read the real value:

```bash
nginx -T 2>/dev/null | grep -n 'proxy_read_timeout\|proxy_send_timeout'
```

What happens when it trips is already understood and is acceptable: nginx answers 504, the page reports a failure, **and the sync carries on** — nothing cancels a server action when the client goes away, so it keeps the lock, finishes, and writes its record. A reload says "Running now", a later one says what changed. Record the actual number in the runbook so the next person does not have to rediscover it.

- [ ] **Step 5: Confirm the next run is scheduled**

```bash
systemctl list-timers 'pq-act-sync*'
```

Check the next elapse is 03:00 Melbourne, converted to whatever the server's own clock shows, and that it falls an hour before `pq-backup-db.timer` in the same listing.

- [ ] **Step 6: Check the failure path**

```bash
/usr/local/bin/pq-backup-alert.sh --test
```

And confirm the email names the ACT! sync sensibly if it is triggered by this unit, rather than calling it a backup.

---

## Not in this plan

Writing back to ACT! — that is the next piece, and it has open questions about contact edits that need settling first. Progress reporting for a long manual run, which should not be needed once the timer is in place. A history of runs: one row answers the question being asked, and a table can be added the day somebody asks a different one.
