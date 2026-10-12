import { describe, it, expect } from "vitest";
import {
  DRAIN_BUSY_MESSAGE,
  SYNC_NOW_DRAIN_BUDGET_MS,
  drainLockApproach,
} from "../src/lib/act/sync-drain-lock";

describe("drainLockApproach", () => {
  it("has the button ask once, never wait", () => {
    // nginx gives the button 60 seconds; another drain can take minutes. A
    // button that waited could also outlast them and replace last night's
    // good record with a timeout for a press that read nothing.
    expect(drainLockApproach({ waitForDrainLock: false })).toBe("try");
    expect(drainLockApproach({ dryRun: false, waitForDrainLock: false })).toBe("try");
  });

  it("has the nightly run wait, so the night's read is not skipped for a 15-minute tick", () => {
    expect(drainLockApproach({ waitForDrainLock: true })).toBe("wait");
  });

  it("takes no drain lock at all for a dry run, whoever asks", () => {
    expect(drainLockApproach({ dryRun: true, waitForDrainLock: true })).toBe("none");
    expect(drainLockApproach({ dryRun: true, waitForDrainLock: false })).toBe("none");
  });
});

describe("what the button says, and how long its drain may take", () => {
  it("says quotes are being sent, in the page's own voice", () => {
    expect(DRAIN_BUSY_MESSAGE).toBe(
      "Quotes are being sent to ACT! right now, so the sync cannot start yet — try again in a few minutes.",
    );
    // The section's sentences use an em dash and no contractions.
    expect(DRAIN_BUSY_MESSAGE).toContain(" — ");
    expect(DRAIN_BUSY_MESSAGE).not.toMatch(/n't/);
  });

  it("gives the button's drain a third of nginx's 60 seconds", () => {
    // The other two thirds are for the step in flight when it runs out and
    // for the read. (src/lib/act/drain.ts is not imported to compare with
    // DRAIN_TIME_BUDGET_MS: it brings the database with it.)
    expect(SYNC_NOW_DRAIN_BUDGET_MS).toBe(20_000);
    expect(SYNC_NOW_DRAIN_BUDGET_MS * 3).toBeLessThanOrEqual(60_000);
  });
});
