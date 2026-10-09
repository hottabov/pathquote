import { describe, it, expect } from "vitest";
import {
  describeRun,
  failedRun,
  finishedRun,
  messageOf,
  parseStoredRun,
  startedRun,
  type ActSyncRun,
  type RunCounts,
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
    // The first full import is ~12,000 contacts. Pinned because a bare
    // `${run.contactsUpdated}` would read "12000" and look like a simpler way
    // to write the same thing.
    expect(describeRun(run({ contactsUpdated: 12000 })).headline).toContain("12,000");
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
