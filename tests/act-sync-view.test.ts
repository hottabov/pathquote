import { describe, it, expect } from "vitest";
import {
  NIGHTLY_SCHEDULE,
  describeActSyncStatus,
  describeSyncAttempt,
} from "../src/lib/act/sync-view";
import { finishedRun, startedRun, failedRun, type ActSyncRun } from "../src/lib/act/run-record";

// A fixed "now" so every relative phrase below is a function of its arguments
// and nothing in this file reads the clock. The suite has no fake timers (see
// vitest.config.ts on `isolate: false`), which is exactly why
// describeActSyncStatus takes `now` instead of calling `new Date()`.
const NOW = new Date("2026-10-09T18:00:00.000Z"); // 05:00 Melbourne, 10 Oct
const LAST_NIGHT = new Date("2026-10-09T16:00:00.000Z"); // 03:00 Melbourne, 10 Oct

function run(overrides: Partial<ActSyncRun> = {}): ActSyncRun {
  return {
    ...finishedRun(
      startedRun("schedule", LAST_NIGHT),
      {
        contactsCreated: 3,
        contactsUpdated: 11,
        companiesCreated: 2,
        companiesFromNamelessContacts: 0,
        companiesKeyCollisions: 0,
        failed: 0,
      },
      new Date("2026-10-09T16:00:42.000Z"),
    ),
    ...overrides,
  };
}

/** The status the query returns on an ordinary morning, before overrides. */
function status(overrides: Partial<Parameters<typeof describeActSyncStatus>[0]> = {}) {
  return {
    lastRun: run(),
    lastRunUnreadable: false,
    running: false,
    cursor: new Date("2026-10-09T15:58:00.000Z"),
    ...overrides,
  };
}

describe("describeActSyncStatus — when it last ran", () => {
  it("says it both ways, because the two answer different questions", () => {
    const view = describeActSyncStatus(status(), NOW);
    // Relative: is this stale? Absolute: was it before or after I changed that
    // record? Neither substitutes for the other.
    expect(view.when).toEqual({
      absolute: "10 Oct 2026, 3:00 am Melbourne time",
      relative: "2 hours ago",
    });
  });

  it("prints the hour in Melbourne, and says so", () => {
    // The timestamp is stored in UTC and the schedule beside it on the page is
    // quoted in Melbourne. An hour printed in the server's own zone, with no
    // zone named, is an invitation to subtract from the wrong number: this run
    // started at 16:00 UTC, which is the 03:00 the nightly timer fires at.
    const view = describeActSyncStatus(status(), NOW);
    expect(view.when?.absolute).toContain("3:00 am");
    expect(view.when?.absolute).toContain("Melbourne time");
    // And the Melbourne date, not the UTC one: 16:00 on the 9th UTC is the
    // small hours of the 10th there.
    expect(view.when?.absolute).toContain("10 Oct 2026");
  });

  it("reads startedAt, the one timestamp every record has", () => {
    // A run that threw or was killed never wrote an ending, so reading
    // finishedAt would leave the question unanswered in exactly the states
    // somebody is on this page to investigate.
    const killed = run({ finishedAt: null });
    expect(describeActSyncStatus(status({ lastRun: killed }), NOW).when).not.toBeNull();
  });

  it("has no timestamp to give when there is no readable record", () => {
    // Not "Never" invented here: the headline carries that, and inventing a
    // second phrasing of it in the page would be two sentences for one fact.
    expect(describeActSyncStatus(status({ lastRun: null, cursor: null }), NOW).when).toBeNull();
    expect(
      describeActSyncStatus(status({ lastRun: null, lastRunUnreadable: true }), NOW).when,
    ).toBeNull();
  });
});

describe("describeActSyncStatus — what the last run did", () => {
  it("hands describeRun's words straight through on a clean night", () => {
    const view = describeActSyncStatus(status(), NOW);
    expect(view.summary).toEqual({
      tone: "ok",
      headline: "3 contacts added, 11 updated, 2 companies added",
      detail: null,
      trigger: "Scheduled",
    });
  });

  it("warns, in amber's tone, about two clients that look alike", () => {
    const view = describeActSyncStatus(
      status({ lastRun: run({ companiesKeyCollisions: 1 }) }),
      NOW,
    );
    expect(view.summary.tone).toBe("warn");
    expect(view.summary.detail).toContain("looks like a client you already have");
  });

  it("leads with the count when contacts failed, and promises they are not lost", () => {
    // The string this detail replaced said "The cursor did not move, so nothing
    // was skipped". True, and in a vocabulary the one person who reads this
    // page does not have. Pinned here because the warning runActSyncNow returns
    // quotes it word for word, and because "cursor" creeping back in is the
    // likely way this regresses.
    const view = describeActSyncStatus(status({ lastRun: run({ failed: 2 }) }), NOW);
    expect(view.summary.tone).toBe("error");
    expect(view.summary.headline).toBe("2 contacts failed");
    expect(view.summary.detail).toBe(
      "Nothing was skipped — those contacts will be tried again on the next sync. If it keeps happening, ask your developer to look into it.",
    );
    expect(view.summary.detail).not.toContain("cursor");
  });

  it("does not report a live sync as a dead one", () => {
    // Same record either way -- written at the start, no ending yet -- and only
    // the advisory lock separates them.
    const live = run({ finishedAt: null });
    expect(describeActSyncStatus(status({ lastRun: live, running: true }), NOW).summary.headline).toBe(
      "Running now",
    );
    expect(describeActSyncStatus(status({ lastRun: live, running: false }), NOW).summary.headline).toBe(
      "Started and never finished",
    );
  });

  it("says a sync HAS run when its record cannot be read, and never 'never'", () => {
    // The whole reason lastRunUnreadable is a separate field. "Never run" about
    // a job that runs every night is wrong in the way nobody investigates,
    // because it looks like an answer.
    const view = describeActSyncStatus(
      status({ lastRun: null, lastRunUnreadable: true }),
      NOW,
    );
    expect(view.summary.tone).toBe("warn");
    expect(view.summary.headline).toContain("A sync has run");
    expect(view.summary.headline.toLowerCase()).not.toContain("never");
    expect(view.summary.detail?.toLowerCase()).not.toContain("never");
    // And points at the person who can do something about it, rather than
    // leaving it looking like an ACT! fault.
    expect(view.summary.detail).toContain("developer");
    // Nobody started it, so nothing is attributed to a trigger.
    expect(view.summary.trigger).toBeNull();
  });

  it("says 'Never run' only when nothing has been recorded AND nothing is stored", () => {
    const view = describeActSyncStatus(status({ lastRun: null, cursor: null }), NOW);
    expect(view.summary.headline).toBe("Never run");
    expect(view.summary.tone).toBe("warn");
    expect(view.summary.detail).toContain("nothing has come across from ACT! yet");
    // Pinned together with the cursor, because the bug this pair closed was a
    // `cursor: null` standing beside every "Never run" assertion in this file
    // while the code read no cursor at all: the state the deploy actually lands
    // in -- a cursor and no record -- was asserted nowhere, and got this
    // headline.
    expect(view.caughtUpTo.headline).toBe("Nothing yet");
  });

  it("does not say 'Never run' about an import that has already happened", () => {
    // THE DEPLOY STATE. `act.sync.lastRun` is new on this branch, so the
    // production full import of 2026-10-08 left a cursor and no run record, and
    // this is what the director sees on the first page load after the release.
    // "Never run" was three false statements at once there: 17,529 contacts had
    // come across, the first import did not need running on the server, and the
    // Caught up to card below said so in the same breath.
    const view = describeActSyncStatus(status({ lastRun: null }), NOW);
    expect(view.summary.headline).toBe("No run recorded yet");
    expect(view.summary.headline.toLowerCase()).not.toContain("never");
    expect(view.summary.detail).toContain("Contacts have already come across from ACT!");
    expect(view.summary.detail?.toLowerCase()).not.toContain("never");
    // Not an error and not an action item: it fixes itself at the next run, and
    // every install of this release opens on it.
    expect(view.summary.tone).toBe("ok");
    // Nobody started a run, so there is nothing to attribute and no timestamp.
    expect(view.summary.trigger).toBeNull();
    expect(view.when).toBeNull();
  });

  it("agrees with the two cards beneath it in that state", () => {
    // The three things on one screen, read as a set. The summary used to
    // contradict both of the others: it sent the reader to the server for a
    // first import while the card below offered him the button and called it
    // seconds, and it said nothing had come across directly above the date it
    // had come across up to.
    const view = describeActSyncStatus(status({ lastRun: null }), NOW);
    expect(view.summary.detail).toContain("Caught up to");
    expect(view.summary.detail).toContain("Press Sync now");
    expect(view.caughtUpTo.headline).toBe(
      "Everything edited in ACT! up to 10 Oct 2026, 2:58 am Melbourne time",
    );
    expect(view.runNow.kind).toBe("offer");
    if (view.runNow.kind !== "offer") throw new Error("unreachable");
    // The hint stands unchanged: a stored position means there IS a short list
    // of changes to fetch, which is the only claim it makes. What it must not
    // do is say "a few seconds" beside a summary telling him to go to the
    // server, and that half is gone.
    expect(view.runNow.hint).toContain("Usually a few seconds");
    expect(view.summary.detail).not.toContain("run on the server");
    // And the nightly hour is not transcribed a second time here: the schedule
    // card holds the only copy in the app (NIGHTLY_SCHEDULE), kept in step by
    // hand with the timer unit, and a second copy is how the page comes to
    // disagree with the unit that decides it.
    expect(view.summary.detail).not.toContain("3:00");
  });

  it("puts a live run ahead of both of those headlines", () => {
    // The worker writes its record before it reads a contact, so a missing or
    // unreadable record while the lock is held is odd -- but "Never run" and "a
    // sync has run" are both false about a sync that is running, and this page
    // must not say a false thing about the state it is most likely to be read
    // in.
    const missing = describeActSyncStatus(
      status({ lastRun: null, running: true, cursor: null }),
      NOW,
    );
    expect(missing.summary.headline).toBe("Running now");
    expect(missing.summary.detail).toContain("nothing was recorded when it started");

    // Including ahead of the new no-record-with-cursor headline, which is the
    // pairing the deploy state produces the moment anything takes the lock:
    // the first nightly run inside the round trip before its start record
    // lands, or a `--dry-run`, which records nothing at either end. "No run
    // recorded yet" is true of the record and useless about the sync that is
    // reading ACT! right now.
    const liveOnDeployState = describeActSyncStatus(
      status({ lastRun: null, running: true }),
      NOW,
    );
    expect(liveOnDeployState.summary.headline).toBe("Running now");

    const unreadable = describeActSyncStatus(
      status({ lastRun: null, lastRunUnreadable: true, running: true }),
      NOW,
    );
    expect(unreadable.summary.headline).toBe("Running now");
    expect(unreadable.summary.detail).toContain("cannot read");
  });

  it("leads with the message when the run threw", () => {
    const threw = failedRun(startedRun("manual", LAST_NIGHT), {
      contactsCreated: 0,
      contactsUpdated: 0,
      companiesCreated: 0,
      companiesFromNamelessContacts: 0,
      companiesKeyCollisions: 0,
      failed: 0,
    }, new Error("authorize failed (401)"));
    const view = describeActSyncStatus(status({ lastRun: threw }), NOW);
    expect(view.summary.tone).toBe("error");
    expect(view.summary.headline).toContain("authorize failed (401)");
    expect(view.summary.trigger).toBe("Run by hand");
  });
});

describe("describeActSyncStatus — the reload control", () => {
  it("is offered whenever a sync holds the lock", () => {
    // The one-way guarantee that matters: describeRun says "Reload this page"
    // only in its running branch, and this module only when `running` is true
    // as well, so the instruction is never printed without the control. Pinned
    // because nothing else connects the sentence to the button.
    for (const lastRun of [run({ finishedAt: null }), run(), null]) {
      expect(describeActSyncStatus(status({ lastRun, running: true }), NOW).reload).toBe(true);
    }
    expect(describeActSyncStatus(status({ running: false }), NOW).reload).toBe(false);
  });

  it("is there in every state whose wording asks for a reload", () => {
    const telling = describeActSyncStatus(
      status({ lastRun: run({ finishedAt: null }), running: true }),
      NOW,
    );
    expect(telling.summary.detail).toContain("Reload this page");
    expect(telling.reload).toBe(true);

    // The dangerous direction, which the one example above leaves open. The
    // superset guarantee has three links -- the sentence appears only while
    // running, `reload` is true exactly while running, so the sentence is never
    // printed without the control -- and until now only the second was pinned
    // across every state. This pins the first: no state that is not running may
    // ask for a reload it is not offering. `?? ""` so a null detail asserts
    // rather than skips.
    const quiet = [
      status({ running: false }),
      status({ lastRun: run({ finishedAt: null }), running: false }),
      status({ lastRun: run({ failed: 2 }), running: false }),
      status({ lastRun: run({ companiesKeyCollisions: 1 }), running: false }),
      status({ lastRun: null, running: false, cursor: null }),
      status({ lastRun: null, running: false }),
      status({ lastRun: null, lastRunUnreadable: true, running: false }),
    ];
    for (const state of quiet) {
      const view = describeActSyncStatus(state, NOW);
      expect(view.reload).toBe(false);
      expect(view.summary.detail ?? "").not.toContain("Reload this page");
    }
  });
});

describe("describeActSyncStatus — the Sync now button", () => {
  it("offers it, with what it does, once there is a stored position", () => {
    const view = describeActSyncStatus(status(), NOW);
    expect(view.runNow).toEqual({
      kind: "offer",
      hint: "Brings PathQuote up to date with the changes made in ACT! since the last sync. Usually a few seconds. Leave this page open while it works.",
    });
  });

  it("withholds it entirely when nothing is stored", () => {
    // With no stored position "the changes since last time" means every contact
    // in ACT! -- ~17,500, ten minutes or more -- longer than any proxy read
    // timeout anybody sets by hand, so the likely outcome is a gateway error
    // over a sync still running. A disabled button would not explain that; this
    // does.
    const view = describeActSyncStatus(status({ cursor: null }), NOW);
    expect(view.runNow.kind).toBe("withhold");
    if (view.runNow.kind !== "withhold") throw new Error("unreachable");
    expect(view.runNow.headline).toContain("run on the server");
    expect(view.runNow.detail).toContain("17,500");
    expect(view.runNow.detail).toContain("developer");
  });

  it("withholds it on a null cursor even when a run has been recorded", () => {
    // Reachable: a run whose very first contact failed never checkpoints, so a
    // finished record and no stored position go together. The cursor decides
    // this, not the record.
    expect(
      describeActSyncStatus(status({ lastRun: run({ failed: 1 }), cursor: null }), NOW).runNow.kind,
    ).toBe("withhold");
  });

  it("withholds it on a null cursor under a record that reports a clean run", () => {
    // The screen singled out above was the easy half: `failed: 1` makes the
    // summary say so too, in rose, which is not a confusing page. This is the
    // confusing one -- "3 contacts added, 11 updated" in slate, directly above
    // "The first import has to be run on the server" in amber -- and it is
    // reachable two further ways that also never checkpoint (see `checkpoint`
    // in src/lib/act/sync.ts): any `--limit` sample run, which is how a
    // developer would first try this on the box, and a run in which every
    // record was skipped, though that one reads "No changes" rather than a
    // count.
    //
    // Nothing is added to reconcile the two, and that is a decision rather than
    // an omission. The page already reconciles them, twice and in the cards
    // whose subject it is: "Caught up to -- Nothing yet", which says the next
    // sync reads every contact, and the withheld button, which says PathQuote
    // has not caught up to any point in ACT!'s history yet. A third sentence
    // would be a third wording of one fact, which is the defect this branch
    // has spent its length removing -- and it would have to come from
    // summaryFor, which would mean describeRun's words answering for a field
    // the record does not carry.
    const view = describeActSyncStatus(status({ lastRun: run(), cursor: null }), NOW);
    expect(view.runNow.kind).toBe("withhold");
    expect(view.summary.headline).toBe("3 contacts added, 11 updated, 2 companies added");
    expect(view.summary.tone).toBe("ok");
    expect(view.caughtUpTo.headline).toBe("Nothing yet");
  });

  it("still offers it while a sync is running, and says what will happen", () => {
    // Pressing it loses the advisory-lock race and comes back with the lock's
    // own sentence, which is true and harmless -- so the button stays, and the
    // hint says so in advance instead of letting him find out.
    const view = describeActSyncStatus(status({ running: true }), NOW);
    expect(view.runNow.kind).toBe("offer");
    if (view.runNow.kind !== "offer") throw new Error("unreachable");
    expect(view.runNow.hint).toContain("will not start a second one");
  });
});

describe("describeActSyncStatus — the schedule and the stored position", () => {
  it("quotes the nightly schedule the timer unit sets", () => {
    expect(describeActSyncStatus(status(), NOW).schedule).toBe(NIGHTLY_SCHEDULE);
    expect(NIGHTLY_SCHEDULE).toContain("3:00 am");
    expect(NIGHTLY_SCHEDULE).toContain("Melbourne");
  });

  it("says where it has got to without the word 'cursor'", () => {
    const view = describeActSyncStatus(status(), NOW);
    expect(view.caughtUpTo.headline).toBe(
      "Everything edited in ACT! up to 10 Oct 2026, 2:58 am Melbourne time",
    );
    // The reason it is on the page at all: it is what explains "No changes" on
    // a morning after somebody edited ACT!.
    expect(view.caughtUpTo.detail).toContain("not something the next sync will go back for");
    for (const text of [view.caughtUpTo.headline, view.caughtUpTo.detail]) {
      expect(text.toLowerCase()).not.toContain("cursor");
    }
  });

  it("says plainly that it has got nowhere yet", () => {
    const view = describeActSyncStatus(status({ cursor: null }), NOW);
    expect(view.caughtUpTo.headline).toBe("Nothing yet");
    expect(view.caughtUpTo.detail).toContain("reads every contact");
    expect(view.caughtUpTo.detail.toLowerCase()).not.toContain("cursor");
  });
});

describe("describeSyncAttempt", () => {
  it("reports a clean run as finished, and claims nothing more than that", () => {
    // It used to end "— PathQuote is up to date with ACT!", which a clean run
    // does not earn: contacts whose company has no usable name are skipped, the
    // stored position moves past them anyway, and those counts reach neither
    // the record nor this page. What changed is in the section beneath.
    const attempt = describeSyncAttempt({ answered: true, result: {} });
    expect(attempt).toEqual({ outcome: "done", message: "Sync finished." });
    expect(attempt.message).not.toContain("up to date");
  });

  it("passes a warning through as a note, not a failure", () => {
    // The lost lock race arrives already worded from the action, and it is not
    // a fault: the nightly job or another admin is doing that work right now.
    const attempt = describeSyncAttempt({
      answered: true,
      result: { warning: "A sync is already running. Wait for it to finish and try again." },
    });
    expect(attempt.outcome).toBe("note");
    expect(attempt.message).toBe("A sync is already running. Wait for it to finish and try again.");
  });

  it("reports a real failure as its own message", () => {
    const attempt = describeSyncAttempt({ answered: true, result: { error: "authorize failed (401)" } });
    expect(attempt).toEqual({ outcome: "failed", message: "authorize failed (401)" });
  });

  it("prefers the error when somehow handed both", () => {
    expect(
      describeSyncAttempt({ answered: true, result: { error: "boom", warning: "hm" } }).outcome,
    ).toBe("failed");
  });

  it("does NOT call a call that never came back a failed sync", () => {
    // The 504 case, which is the one this function exists for. nginx stops
    // waiting at its proxy_read_timeout and the action promise rejects, while
    // the sync keeps the lock, finishes and writes its record. Reporting that
    // as a failure is the one wrong answer this section can give: it would send
    // somebody looking for a fault while the work completes behind them.
    const attempt = describeSyncAttempt({ answered: false });
    expect(attempt.outcome).toBe("no-answer");
    expect(attempt.outcome).not.toBe("failed");
    expect(attempt.message.toLowerCase()).not.toContain("failed");
    // And says the two things that are true: giving up waiting is not what
    // stops a run, and a reload will show where it got to. Scoped to a sync
    // that started, not flat, because this branch is also reached by a 502 from
    // a node restart mid-run and by a stale action id after a deploy (`E715`),
    // the second of which can arrive with no sync ever having been started.
    expect(attempt.message).toContain("does not stop a sync that had already started");
    expect(attempt.message).toContain("Reload this page");
  });
});
