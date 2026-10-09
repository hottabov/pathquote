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

  it("does not call a killed run a clean one", () => {
    // No ending written and no error: the run was stopped rather than having
    // failed on its own, which is what a reboot or a kill -9 leaves behind once
    // the record is written at the start of a run. Every counter is still at
    // its opening value, so without a branch of its own this reads as "No
    // changes" -- a run that never came back reported as a quiet success.
    const described = describeRun(
      run({
        finishedAt: null,
        contactsCreated: 0,
        contactsUpdated: 0,
        companiesCreated: 0,
      }),
    );
    expect(described.tone).toBe("error");
    expect(described.headline).not.toContain("No changes");
  });

  it("keeps the failed count when the run also threw", () => {
    // The error is the headline because it is the specific thing to act on, but
    // contacts that failed before it are not dropped on the floor.
    const described = describeRun(
      run({ finishedAt: null, error: "ECONNRESET", failed: 3 }),
    );
    expect(described.headline).toContain("ECONNRESET");
    expect(described.detail).toContain("3 contacts");
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
