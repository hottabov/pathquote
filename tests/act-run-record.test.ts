import { describe, it, expect } from "vitest";
import type { DrainResult } from "../src/lib/act/drain";
import { UNTRACKED_CONTACT_REASON, NO_CONTACT_REASON } from "../src/lib/act/outbox-plan";
import {
  describeRun,
  drainSummary,
  drainThrew,
  failedRun,
  finishedRun,
  messageOf,
  parseStoredRun,
  startedRun,
  type ActSyncRun,
  type RunCounts,
  type RunDrain,
} from "../src/lib/act/run-record";

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
    drain: null,
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

  it("keeps the noun on the first phrase when nothing was added", () => {
    // What most nights look like: existing contacts edited, nothing new. The
    // second noun is dropped only because the first phrase carried it, so when
    // "updated" leads it has to carry its own -- a bare "11 updated, 2
    // companies added" invites reading the 11 as companies.
    expect(describeRun(run({ contactsCreated: 0 })).headline).toBe(
      "11 contacts updated, 2 companies added",
    );
  });

  it("groups thousands in a count", () => {
    // The first full import is ~17,500 contacts (17,529 measured in production
    // on 2026-10-08). Pinned because a bare `${run.contactsUpdated}` would read
    // "17529" and look like a simpler way to write the same thing.
    expect(describeRun(run({ contactsUpdated: 17529 })).headline).toContain("17,529");
  });

  it("says so plainly when a run changed nothing", () => {
    // The common case once the nightly job is running: nobody edited ACT!
    // yesterday. "0 contacts added, 0 updated" reads like a fault.
    expect(
      describeRun(run({ contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0 })),
    ).toMatchObject({ tone: "ok", headline: "No changes" });
  });

  it("leads with the failure when one contact failed", () => {
    // One, not two: the singular arm of `plural` is otherwise never exercised
    // on the contact strings, and this catches the headline being rewritten as
    // `${run.failed} contacts failed`.
    const described = describeRun(run({ failed: 1 }));
    expect(described.tone).toBe("error");
    expect(described.headline).toContain("1 contact failed");
  });

  it("says what happens to the contacts that failed, without saying 'cursor'", () => {
    // This detail used to read "The cursor did not move, so nothing was
    // skipped -- fix the cause and run it again." Accurate, and in this
    // repository's vocabulary rather than that of the one person who reads the
    // page it is rendered on (Settings -> ACT! sync). It now says the same
    // thing as a consequence: those contacts are waiting, not lost.
    //
    // True because `failed > 0` freezes the checkpoint for the rest of the run
    // (`checkpoint` in src/lib/act/sync.ts), so the next sync asks ACT! for a
    // window that still contains them. The error branch above deliberately does
    // NOT make that promise -- a run that threw on page nine has already moved
    // the position eight times -- which is why the two details differ.
    //
    // Pinned as a whole string, not a substring, because runActSyncNow puts
    // this same sentence in the warning its toast shows: the two are one
    // sentence about one fact, and a page that says this under a toast saying
    // something slightly different reads as two different facts. It is the
    // exported FAILED_CONTACTS_DETAIL at both sites rather than two copies, so
    // the literal below is now the only place the words are written down twice
    // -- which is what a test is for.
    expect(describeRun(run({ failed: 2 })).detail).toBe(
      "Nothing was skipped — those contacts will be tried again on the next sync. If it keeps happening, ask your developer to look into it.",
    );
    expect(describeRun(run({ failed: 2 })).detail).not.toContain("cursor");
  });

  it("leads with the error when the run never finished", () => {
    const described = describeRun(run({ finishedAt: null, error: "authorize failed (401)" }));
    expect(described.tone).toBe("error");
    expect(described.headline).toContain("authorize failed (401)");
  });

  it("says a run with no ending is going on right now when the lock is held", () => {
    // The record of a run in progress is identical to the record of one that
    // was killed: written at the start, no ending yet. Only the advisory lock
    // separates them (isSyncRunning in sync.ts), so the caller passes the
    // answer in -- and without this the nightly sync, while it is working
    // perfectly, reports itself as having died.
    const described = describeRun(
      run({ finishedAt: null, contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0 }),
      { running: true },
    );
    expect(described.tone).toBe("ok");
    expect(described.headline).toBe("Running now");
    expect(described.headline).not.toContain("never finished");
    expect(described.detail).toContain("Reload this page");
  });

  it("still leads with the message when a run that threw has not let go of the lock yet", () => {
    // The failed record is written before the lock connection closes, so for
    // that instant both are true. The message is the more useful of the two.
    const described = describeRun(run({ finishedAt: null, error: "ECONNRESET" }), {
      running: true,
    });
    expect(described.tone).toBe("error");
    expect(described.headline).toContain("ECONNRESET");
  });

  it("does not call a killed run a clean one", () => {
    // No ending written and no error: the run was stopped rather than having
    // failed on its own, which is what a reboot or a kill -9 leaves behind once
    // the record is written at the start of a run. Every counter is still at
    // its opening value, so without a branch of its own this reads as "No
    // changes" -- a run that never came back reported as a quiet success.
    // Called with no second argument on purpose: nothing running is the
    // default, so a caller that cannot be bothered to ask gets the cautious
    // answer rather than the reassuring one.
    const described = describeRun(
      run({
        finishedAt: null,
        contactsCreated: 0,
        contactsUpdated: 0,
        companiesCreated: 0,
      }),
    );
    expect(described.tone).toBe("error");
    expect(described.headline).toBe("Started and never finished");
    expect(described.headline).not.toContain("No changes");
    // And explicitly not-running says the same thing, since that is the state
    // the Settings page will actually pass for a run that died.
    expect(describeRun(run({ finishedAt: null }), { running: false }).headline).toBe(
      "Started and never finished",
    );
    // And names no control, because this module cannot know whether that one is
    // on the page. The detail used to end "press Sync now to bring it up to
    // date", which Settings withholds whenever there is no stored position --
    // the state a killed first full import leaves behind, since nothing
    // checkpoints until a page completes. What replaced it is true whether the
    // button is there or not.
    expect(described.detail).not.toContain("Sync now");
    expect(described.detail).toContain("the next sync carries on");
  });

  it("keeps the failed count when the run also threw", () => {
    // The error is the headline because it is the specific thing to act on, but
    // contacts that failed before it are not dropped on the floor.
    const described = describeRun(
      run({ finishedAt: null, error: "ECONNRESET", failed: 3 }),
    );
    expect(described.headline).toContain("ECONNRESET");
    expect(described.detail).toContain("3 contacts had already failed");
    // And says what a thrown run shares with a merely failed one: the reader
    // should not have to assume records were lost. Not in terms of the cursor,
    // which a thrown run may well have moved -- only ever past records already
    // stored, which is why nothing is skipped either way.
    expect(described.detail).toContain("Nothing was skipped");
  });

  it("says what a key collision means for the client list", () => {
    // Two different ACT! companies whose names normalise alike, so the second
    // one became a client row of its own (see chooseCompany in
    // company-identity.ts). Nothing is broken, but there are now two
    // look-alike clients in the picker and a quote can go to the wrong one --
    // which is what this has to say, not that a key collided.
    const described = describeRun(run({ companiesKeyCollisions: 2 }));
    expect(described.tone).toBe("warn");
    expect(described.detail).toBe(
      "2 new clients have names that look like clients you already have — check the client list before quoting any of them.",
    );
    // One collision is its own sentence rather than the plural one with a
    // different number in it, so it is pinned here too.
    expect(describeRun(run({ companiesKeyCollisions: 1 })).detail).toBe(
      "1 new client has a name that looks like a client you already have — check the client list before quoting either of them.",
    );
  });

  it("counts nameless arrivals as the contacts they are", () => {
    // companiesFromNamelessContacts counts records, not distinct companies:
    // two nameless contacts at one firm count twice. Saying "4 companies"
    // invites reconciling the number against the client list, where it will
    // not match.
    const detail = describeRun(run({ companiesFromNamelessContacts: 4 })).detail;
    expect(detail).toContain("4 contacts arrived with a company but no person's name");
    expect(detail).not.toContain("companies");
  });

  it("says which trigger started it", () => {
    expect(describeRun(run({ trigger: "manual" })).trigger).toBe("Run by hand");
    expect(describeRun(run({ trigger: "schedule" })).trigger).toBe("Scheduled");
  });
});

describe("the three records one run can leave", () => {
  const startedAt = new Date("2026-10-09T17:00:00.000Z");
  const finishedAt = new Date("2026-10-09T17:09:30.000Z");
  const counts: RunCounts = {
    contactsCreated: 4,
    contactsUpdated: 12,
    companiesCreated: 1,
    companiesFromNamelessContacts: 2,
    companiesKeyCollisions: 1,
    failed: 3,
  };

  it("opens with every counter at zero and no ending", () => {
    // What a run that is killed leaves behind, and the reason the counters
    // cannot be read as "it did nothing" -- describeRun's no-ending branch
    // never reaches them.
    expect(startedRun("schedule", startedAt)).toEqual({
      startedAt: "2026-10-09T17:00:00.000Z",
      finishedAt: null,
      trigger: "schedule",
      contactsCreated: 0,
      contactsUpdated: 0,
      companiesCreated: 0,
      companiesFromNamelessContacts: 0,
      companiesKeyCollisions: 0,
      failed: 0,
      error: null,
      drain: null,
    });
  });

  it("closes with the counters and an ending, keeping the start it opened with", () => {
    const started = startedRun("schedule", startedAt);
    expect(finishedRun(started, counts, finishedAt)).toEqual({
      ...counts,
      startedAt: "2026-10-09T17:00:00.000Z",
      finishedAt: "2026-10-09T17:09:30.000Z",
      trigger: "schedule",
      error: null,
      drain: null,
    });
  });

  it("records a run that threw with the counters it had reached and no ending", () => {
    // The counters matter here: a run that threw on contact 9,000 stored
    // 9,000 contacts, and the second line of describeRun's error branch
    // reports the failures among them.
    //
    // Asserted whole, which it can be because no builder here reads the clock:
    // the whole record is a function of its three arguments, so there is no
    // field this test has to leave alone.
    const record = failedRun(startedRun("manual", startedAt), counts, new Error("authorize 401"));
    expect(record).toEqual({
      ...counts,
      startedAt: "2026-10-09T17:00:00.000Z",
      finishedAt: null,
      trigger: "manual",
      error: "authorize 401",
      drain: null,
    });
    expect(describeRun(record).headline).toContain("authorize 401");
  });

  it("finds words for a throw that had none", () => {
    // describeRun leads with `error` only when it is truthy, so an empty
    // message would send a run that threw down the killed-run branch and
    // report it as having been stopped partway. Anything thrown gets words.
    const started = startedRun("manual", startedAt);
    for (const thrown of [new Error(""), new Error("   "), undefined, null, ""]) {
      const record = failedRun(started, counts, thrown);
      expect(record.error).toBeTruthy();
      expect(describeRun(record).headline).toContain("Failed:");
    }
    expect(failedRun(started, counts, "ACT! said no").error).toBe("ACT! said no");
  });
});

describe("messageOf", () => {
  it("always has words, whatever was thrown", () => {
    // Exported because the Sync now action returns this to the admin who
    // pressed the button, where a blank message would paint an empty banner.
    expect(messageOf(new Error("authorize failed (401)"))).toBe("authorize failed (401)");
    expect(messageOf("ACT! said no")).toBe("ACT! said no");
    expect(messageOf(new Error("  "))).toBeTruthy();
    expect(messageOf(undefined)).toBeTruthy();
  });
});

describe("parseStoredRun", () => {
  // What the Settings page is actually handed: the record, through JSON and
  // back, exactly as Prisma returns a jsonb column.
  function stored(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
  }

  const written = finishedRun(
    startedRun("schedule", new Date("2026-10-09T17:00:00.000Z")),
    {
      contactsCreated: 3,
      contactsUpdated: 11,
      companiesCreated: 2,
      companiesFromNamelessContacts: 0,
      companiesKeyCollisions: 0,
      failed: 0,
    },
    new Date("2026-10-09T17:00:42.000Z"),
  );

  it("reads back a record this module wrote", () => {
    expect(parseStoredRun(stored(written))).toEqual(written);
  });

  it("reads back the record a run writes when it starts", () => {
    // No ending yet, which is the record the page sees while a sync is going.
    // Rejecting a null `finishedAt` would blank the page for every run in
    // progress.
    const started = startedRun("manual", new Date("2026-10-09T17:00:00.000Z"));
    expect(parseStoredRun(stored(started))).toEqual(started);
  });

  it("rejects anything that is not an object", () => {
    // The row's value is a bare Json column: a hand-written `"none"` or a
    // mistaken array is as storable as a record. Not put through `stored`:
    // `undefined` is not JSON, which is the point -- it cannot come out of the
    // column, and the guard takes it anyway rather than resting on that.
    for (const value of [null, undefined, "none", 7, true, [written]]) {
      expect(parseStoredRun(value)).toBeNull();
    }
  });

  it("rejects a record missing a counter", () => {
    const withoutOne: Record<string, unknown> = { ...written };
    delete withoutOne.contactsUpdated;
    expect(parseStoredRun(stored(withoutOne))).toBeNull();

    // Why that is worth rejecting, pinned here rather than claimed in a
    // comment: handed the same record unchecked, describeRun does not throw.
    // Every counter it reads sits behind a `> 0` test and `undefined > 0` is
    // false, so eleven updated contacts simply stop being mentioned.
    expect(describeRun(withoutOne as unknown as ActSyncRun).headline).toBe(
      "3 contacts added, 2 companies added",
    );
  });

  it("rejects a counter that is not a number", () => {
    expect(parseStoredRun(stored({ ...written, failed: "3" }))).toBeNull();
    expect(parseStoredRun(stored({ ...written, failed: null }))).toBeNull();
  });

  it("rejects a negative counter", () => {
    expect(parseStoredRun(stored({ ...written, contactsUpdated: -1 }))).toBeNull();
    expect(parseStoredRun(stored({ ...written, failed: -1 }))).toBeNull();

    // Why it is worth rejecting rather than documenting: handed the same record
    // unchecked, describeRun does not print "-1 updated". Every counter it
    // reads sits behind a `> 0` test, `-1 > 0` is false, and the eleven updated
    // contacts become a night with nothing in it.
    const negative = { ...written, contactsCreated: -1, contactsUpdated: -1, companiesCreated: -1 };
    expect(describeRun(negative).headline).toBe("No changes");
  });

  it("rejects a blank error message", () => {
    // messageOf's whole reason for existing, from the other side: describeRun
    // leads with `error` only when it is truthy, so a stored "" falls past the
    // error branch and a run that threw is reported as "Started and never
    // finished". A record carrying no ending AND no message is the one this
    // boundary must not hand on.
    const threw = { ...written, finishedAt: null, error: "" };
    expect(parseStoredRun(stored(threw))).toBeNull();
    expect(parseStoredRun(stored({ ...threw, error: "   " }))).toBeNull();

    // What it would have said if it got through.
    expect(describeRun(threw).headline).toBe("Started and never finished");
  });

  it("rejects a trigger it does not recognise", () => {
    // Not pedantry: describeRun says "Scheduled" for anything that is not
    // "manual", so a third trigger name read off the row would label a run by
    // hand as the nightly job.
    expect(parseStoredRun(stored({ ...written, trigger: "nightly" }))).toBeNull();
    expect(parseStoredRun(stored({ ...written, trigger: null }))).toBeNull();
  });

  it("rejects a timestamp the clock cannot be read off", () => {
    // The page renders startedAt as a date. A string that is not one reaches
    // the reader as the literal words "Invalid Date".
    expect(parseStoredRun(stored({ ...written, startedAt: "last night" }))).toBeNull();
    expect(parseStoredRun(stored({ ...written, startedAt: null }))).toBeNull();
    expect(parseStoredRun(stored({ ...written, finishedAt: "soon" }))).toBeNull();
  });

  it("rejects an error that is not a message", () => {
    expect(parseStoredRun(stored({ ...written, error: 401 }))).toBeNull();
  });

  it("ignores a field it does not know about, and does not pass it on", () => {
    // A newer version of sync.ts adding a seventh counter must not blank the
    // page for a server still running this one -- and must not smuggle the new
    // field through either, because everything downstream of here is typed as
    // ActSyncRun and would not expect it.
    const fromLater = { ...written, contactsDeleted: 4 };
    expect(parseStoredRun(stored(fromLater))).toEqual(written);
  });
});

// --- the drain ---------------------------------------------------------------

/** A drain pass that sent nothing and found nothing: the ordinary night's. */
function drained(overrides: Partial<RunDrain> = {}): RunDrain {
  return {
    status: "ran",
    stopReason: null,
    stopCause: null,
    rowsDone: 0,
    stepsWritten: 0,
    blocked: 0,
    firstBlockedReason: null,
    heldForContact: 0,
    backingOff: 0,
    untracked: 0,
    waiting: 0,
    ...overrides,
  };
}

function drainResult(overrides: Partial<DrainResult> = {}): DrainResult {
  return {
    status: "ran",
    stopCause: null,
    rowsDone: 0,
    stepsWritten: 0,
    blocked: [],
    failed: [],
    untracked: 0,
    unblocked: 0,
    skippedSwitchOff: 0,
    stopReason: null,
    ...overrides,
  };
}

/** A clean run with nothing inbound, so only the drain has anything to say. */
function quiet(drain: RunDrain | null): ActSyncRun {
  return run({ contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0, drain });
}

describe("drainSummary and drainThrew", () => {
  it("keeps the counts, the first reason, and how many were held for their contact", () => {
    const summary = drainSummary(
      drainResult({
        status: "stopped",
        stopCause: "unavailable",
        stopReason: "PathQuote could not create the opportunity: ACT! did not answer — timeout",
        rowsDone: 3,
        stepsWritten: 9,
        blocked: [
          { documentId: "d1", reason: NO_CONTACT_REASON },
          { documentId: "d2", reason: UNTRACKED_CONTACT_REASON },
          { documentId: "d3", reason: UNTRACKED_CONTACT_REASON },
        ],
        failed: [{ documentId: "d4", error: "x" }],
        untracked: 1,
        unblocked: 4,
        skippedSwitchOff: 0,
      }),
    );
    expect(summary).toEqual({
      status: "stopped",
      stopReason: "PathQuote could not create the opportunity: ACT! did not answer — timeout",
      stopCause: "unavailable",
      rowsDone: 3,
      stepsWritten: 9,
      blocked: 3,
      firstBlockedReason: NO_CONTACT_REASON,
      heldForContact: 2,
      backingOff: 1,
      untracked: 1,
      waiting: 0,
    });
  });

  it("records a drain that threw as failed, with words even for a blank throw", () => {
    expect(drainThrew(new Error("connection terminated"))).toEqual(
      drained({ status: "failed", stopReason: "connection terminated" }),
    );
    expect(drainThrew(new Error("  ")).stopReason).toBeTruthy();
    // Prisma's message for a database failure, shape as measured: the last
    // line is what went wrong, the rest is a frame of source code.
    const prisma = new Error(
      "\nInvalid `db.actOutbox.findMany()` invocation in\n/app/src/lib/act/drain.ts:645:40\n\n  644 async replanBlocked(\n→ 645   const blocked = await db.actOutbox.findMany(\nThe table `public.ActOutbox` does not exist in the current database.",
    );
    expect(drainThrew(prisma).stopReason).toBe("The table `public.ActOutbox` does not exist in the current database.");
  });

  it("goes onto the closing records, and onto no other field", () => {
    // SyncResult carries `drain` as a RunDrain; the closing builders copy it
    // by name, so a stray field on what they were handed stays out of the row.
    const started = startedRun("schedule", new Date("2026-10-09T17:00:00.000Z"));
    const counts: RunCounts = {
      contactsCreated: 0,
      contactsUpdated: 0,
      companiesCreated: 0,
      companiesFromNamelessContacts: 0,
      companiesKeyCollisions: 0,
      failed: 0,
    };
    const drain = { ...drained({ rowsDone: 2 }), unblocked: 7 } as RunDrain;
    const finished = finishedRun(started, { ...counts, drain }, new Date("2026-10-09T17:01:00.000Z"));
    expect(finished.drain).toEqual(drained({ rowsDone: 2 }));
    expect(failedRun(started, { ...counts, drain }, new Error("x")).drain).toEqual(drained({ rowsDone: 2 }));
    // A run that threw before it drained has none.
    expect(failedRun(started, counts, new Error("x")).drain).toBeNull();
  });
});

describe("parseStoredRun, and the drain", () => {
  function stored(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value));
  }

  // Exactly what production's run record looks like the day this ships: the
  // shape finishedRun wrote before `drain` existed, key for key.
  const today = {
    startedAt: "2026-10-12T16:00:00.412Z",
    finishedAt: "2026-10-12T16:00:07.901Z",
    trigger: "schedule",
    contactsCreated: 0,
    contactsUpdated: 14,
    companiesCreated: 1,
    companiesFromNamelessContacts: 0,
    companiesKeyCollisions: 0,
    failed: 0,
    error: null,
  };

  it("still reads a record in today's exact shape, as one with no drain information", () => {
    // Requiring `drain` would make this record unreadable, and the Settings
    // page would say PathQuote cannot read it until the next run.
    expect(parseStoredRun(stored(today))).toEqual({ ...today, drain: null });
    expect(describeRun(parseStoredRun(stored(today))!)).toMatchObject({
      tone: "ok",
      headline: "14 contacts updated, 1 company added",
      detail: null,
    });
  });

  it("still reads today's start record and today's failed record", () => {
    const start = { ...today, finishedAt: null, contactsUpdated: 0, companiesCreated: 0 };
    expect(parseStoredRun(stored(start))).toEqual({ ...start, drain: null });
    const threw = { ...today, finishedAt: null, error: "authorize failed (401)" };
    expect(parseStoredRun(stored(threw))).toEqual({ ...threw, drain: null });
  });

  it("reads a stored null drain as no drain information", () => {
    expect(parseStoredRun(stored({ ...today, drain: null }))).toEqual({ ...today, drain: null });
  });

  it("reads back a record with a drain on it", () => {
    const record = { ...today, drain: drained({ rowsDone: 2, stepsWritten: 6, blocked: 1, firstBlockedReason: NO_CONTACT_REASON }) };
    expect(parseStoredRun(stored(record))).toEqual(record);
  });

  it("holds a drain that is there to the standard of the rest of the record", () => {
    const withDrain = (drain: unknown) => stored({ ...today, drain });
    const missingOne: Record<string, unknown> = { ...drained() };
    delete missingOne.backingOff;
    for (const drain of [
      missingOne,
      { ...drained(), rowsDone: -1 },
      { ...drained(), blocked: "2" },
      { ...drained(), status: "exploded" },
      { ...drained(), stopCause: "weather" },
      { ...drained(), stopReason: "" },
      { ...drained(), firstBlockedReason: "   " },
      { ...drained(), firstBlockedReason: 7 },
      [drained()],
      "ran",
      7,
    ]) {
      expect(parseStoredRun(withDrain(drain))).toBeNull();
    }
  });

  it("does not pass on a field of the drain it does not know about", () => {
    const record = { ...today, drain: { ...drained(), skippedRows: 4 } };
    expect(parseStoredRun(stored(record))).toEqual({ ...today, drain: drained() });
  });
});

describe("describeRun: what the drain did", () => {
  it("says nothing when there is no drain information", () => {
    expect(describeRun(quiet(null))).toMatchObject({ tone: "ok", headline: "No changes", detail: null });
  });

  it("says nothing when the drain had nothing to send", () => {
    expect(describeRun(quiet(drained()))).toMatchObject({ tone: "ok", headline: "No changes", detail: null });
  });

  it("says nothing when sending is switched off and nothing is waiting", () => {
    // Every night until somebody turns sending on, with nothing finalised.
    expect(describeRun(quiet(drained({ status: "switched-off" })))).toMatchObject({
      tone: "ok",
      headline: "No changes",
      detail: null,
    });
  });

  it("says quotes are waiting when sending is switched off, without turning amber", () => {
    // The state right after the write-back is deployed: sending is off on
    // purpose, and finalised quotes are queuing behind it.
    expect(describeRun(quiet(drained({ status: "switched-off", waiting: 3 })))).toEqual({
      tone: "ok",
      headline: "No changes",
      detail: "3 quotes are waiting to go to ACT!, but sending to ACT! is switched off — they go as soon as it is switched on.",
      trigger: "Scheduled",
    });
    expect(describeRun(quiet(drained({ status: "switched-off", waiting: 1 }))).detail).toBe(
      "1 quote is waiting to go to ACT!, but sending to ACT! is switched off — it goes as soon as it is switched on.",
    );
  });

  it("puts the quotes sent in the headline, after the contacts", () => {
    expect(describeRun(run({ contactsCreated: 0, companiesCreated: 0, drain: drained({ rowsDone: 2 }) }))).toMatchObject({
      tone: "ok",
      headline: "11 contacts updated, 2 quotes sent to ACT!",
    });
    // Never "No changes" about a night that sent a quote.
    expect(describeRun(quiet(drained({ rowsDone: 1 }))).headline).toBe("1 quote sent to ACT!");
  });

  it("turns amber for a quote held back, and sends the reader to the quote", () => {
    expect(describeRun(quiet(drained({ blocked: 1, firstBlockedReason: NO_CONTACT_REASON })))).toMatchObject({
      tone: "warn",
      detail: "1 quote was held back from ACT! — the quote's own page says why, and what to do about it.",
    });
    expect(describeRun(quiet(drained({ blocked: 4, firstBlockedReason: NO_CONTACT_REASON }))).detail).toBe(
      "4 quotes were held back from ACT! — each quote's own page says why, and what to do about it.",
    );
  });

  it("says plainly that a quote held for its untracked contact needs a person", () => {
    const one = describeRun(quiet(drained({ blocked: 1, heldForContact: 1, untracked: 1, firstBlockedReason: UNTRACKED_CONTACT_REASON })));
    expect(one).toMatchObject({
      tone: "warn",
      detail:
        "1 quote is held because PathQuote asked ACT! to create its contact and never heard whether it did — somebody has to look in ACT! before it can go on, so ask your developer, and do not delete or re-add that contact.",
    });
    // Counted once: the held-for-contact rows are among `blocked`, and not
    // said again as held back.
    const mixed = describeRun(quiet(drained({ blocked: 3, heldForContact: 2, untracked: 1 }))).detail!;
    expect(mixed).toBe(
      "2 quotes are held because PathQuote asked ACT! to create their contact and never heard whether it did — somebody has to look in ACT! before they can go on, so ask your developer, and do not delete or re-add those contacts. 1 quote was held back from ACT! — the quote's own page says why, and what to do about it.",
    );
  });

  it("says nothing extra about an untracked create that is not a contact's", () => {
    // An opportunity, product line or history PathQuote never heard back
    // about is looked for in ACT! before it is made again; its row backs off.
    expect(describeRun(quiet(drained({ untracked: 1, backingOff: 1 })))).toMatchObject({
      tone: "ok",
      detail: "1 quote did not get through to ACT! this time — PathQuote tries again on its own.",
    });
  });

  it("stays green for quotes backing off, which retry on their own", () => {
    expect(describeRun(quiet(drained({ backingOff: 2 })))).toMatchObject({
      tone: "ok",
      detail: "2 quotes did not get through to ACT! this time — PathQuote tries again on its own.",
    });
  });

  it("stays green when ACT! was busy or away, and quotes no status codes at the reader", () => {
    expect(
      describeRun(quiet(drained({ status: "stopped", stopCause: "unavailable", stopReason: "ACT! answered 429", backingOff: 1 }))),
    ).toMatchObject({
      tone: "ok",
      detail:
        "ACT! was busy or not answering, so sending quotes stopped partway — the rest go on their own once it answers. 1 quote did not get through to ACT! this time — PathQuote tries again on its own.",
    });
  });

  it("turns amber when sending stopped on something that will not mend itself, and quotes why", () => {
    const reason =
      'no ACT! user, or more than one, has the login "Marketing" (ACT_USER), so there is no record manager for a quote whose author has no ACT! user — check ACT_USER against ACT!\'s users';
    expect(describeRun(quiet(drained({ status: "stopped", stopCause: "setup", stopReason: reason })))).toMatchObject({
      tone: "warn",
      detail: `Sending quotes to ACT! stopped: ${reason}. Quotes will not reach ACT! until this is put right — ask your developer.`,
    });
    // One full stop, not two, after a reason that brought its own.
    expect(
      describeRun(quiet(drained({ status: "stopped", stopCause: "setup", stopReason: "the login was refused." }))).detail,
    ).toBe("Sending quotes to ACT! stopped: the login was refused. Quotes will not reach ACT! until this is put right — ask your developer.");
  });

  it("turns amber when the drain threw, and says nothing was lost", () => {
    expect(describeRun(quiet(drained({ status: "failed", stopReason: "connection terminated" })))).toMatchObject({
      tone: "warn",
      headline: "No changes",
      detail:
        "Sending quotes to ACT! failed: connection terminated. Nothing was lost — the quotes stay queued and are tried again on their own; if this keeps happening, ask your developer.",
    });
  });

  it("stays green when a pass ran out of time", () => {
    expect(describeRun(quiet(drained({ status: "out-of-time", rowsDone: 40 })))).toEqual({
      tone: "ok",
      headline: "40 quotes sent to ACT!",
      detail: "There were more quotes to send than one go allows — the rest are sent on their own shortly.",
      trigger: "Scheduled",
    });
  });

  it("says what it means when another send was under way", () => {
    // Not reachable from the sync, which drains under its own lock -- but a
    // status the record can hold has words.
    expect(describeRun(quiet(drained({ status: "busy" })))).toMatchObject({
      tone: "ok",
      detail: "No quotes were sent this time because another send to ACT! was already under way — they go with the next.",
    });
  });

  it("never makes a run worse than amber, and comes after the contact notes", () => {
    const described = describeRun(
      run({ companiesKeyCollisions: 1, drain: drained({ blocked: 1, firstBlockedReason: NO_CONTACT_REASON }) }),
    );
    expect(described.tone).toBe("warn");
    expect(described.detail).toMatch(/^1 new client has a name that looks like.*1 quote was held back from ACT!/);
  });

  it("adds the drain to the second line of a run that threw, and keeps it red", () => {
    const described = describeRun(
      run({ finishedAt: null, error: "authorize failed (401)", drain: drained({ rowsDone: 2, blocked: 1 }) }),
    );
    expect(described).toMatchObject({
      tone: "error",
      headline: "Failed: authorize failed (401)",
      detail:
        "Nothing was skipped — everything it got through is saved, and the next run carries on from there. It sent 2 quotes to ACT! first, and those went through. 1 quote was held back from ACT! — the quote's own page says why, and what to do about it.",
    });
    expect(describeRun(run({ finishedAt: null, error: "x", drain: drained({ rowsDone: 1 }) })).detail).toContain(
      "It sent 1 quote to ACT! first, and that one went through.",
    );
  });

  it("adds the drain to the second line of a run with failed contacts", () => {
    const described = describeRun(run({ failed: 2, drain: drained({ status: "switched-off", waiting: 5 }) }));
    expect(described.tone).toBe("error");
    expect(described.detail).toBe(
      "Nothing was skipped — those contacts will be tried again on the next sync. If it keeps happening, ask your developer to look into it. 5 quotes are waiting to go to ACT!, but sending to ACT! is switched off — they go as soon as it is switched on.",
    );
  });

  it("has nothing to add to a run that is going, or was killed", () => {
    // Their record is the start record, whose drain is null.
    const start = startedRun("schedule", new Date("2026-10-09T17:00:00.000Z"));
    expect(describeRun(start, { running: true }).detail).not.toContain("quote");
    expect(describeRun(start).detail).not.toContain("quote");
  });
});
