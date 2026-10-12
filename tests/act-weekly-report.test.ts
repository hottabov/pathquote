import { describe, it, expect } from "vitest";
import {
  buildWeeklyReportEmail,
  countForManager,
  historyTypeBreakdown,
  previousWeek,
  reportFromAddress,
  resolveManager,
  windowForDays,
} from "../src/lib/act/weekly-report";
import { parseWeeklyReportArgs } from "../src/lib/act/weekly-report-args";
import type { ActContact, ActHistory, ActUser } from "../src/lib/act/types";

const BRANDON = "f5e2ef96-3b7e-4912-ae06-59a1dfd8c560";
const CHRIS = "c3aba2a5-d0fa-4a1c-8b5c-77e8a794a6d8";

let seq = 0;
function history(overrides: Partial<ActHistory>): ActHistory {
  seq += 1;
  return {
    id: `h${seq}`,
    historyTypeID: 1,
    historyType: null,
    recordManagerID: BRANDON,
    recordManager: "Brandon Clark",
    startTime: "2026-10-06T01:00:00Z",
    created: "2026-10-06T01:00:00Z",
    isPrivate: false,
    ...overrides,
  };
}

function contact(overrides: Partial<ActContact>): ActContact {
  seq += 1;
  return {
    id: `c${seq}`,
    companyID: "",
    idStatus: "Prospect",
    contactType: "Contact",
    isPrivate: false,
    firstName: null,
    lastName: null,
    jobTitle: null,
    emailAddress: null,
    businessPhone: null,
    mobilePhone: null,
    company: null,
    website: null,
    businessAddress: null,
    recordManagerID: BRANDON,
    recordManager: "Brandon Clark",
    customFields: null,
    created: "2026-10-06T01:00:00Z",
    edited: "2026-10-06T01:00:00Z",
    ...overrides,
  };
}

describe("the window", () => {
  it("covers Melbourne days, inclusive, as half-open UTC instants", () => {
    const w = windowForDays({ year: 2026, month: 10, day: 4 }, { year: 2026, month: 10, day: 11 });
    // Clocks go forward at 02:00 on Sunday 04.10.2026, so that midnight is
    // still AEST (+10); 12.10 midnight is AEDT (+11).
    expect(w.from.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-11T13:00:00.000Z");
    expect(w.label).toBe("04.10-11.10");
  });

  it("gets midnight right across the daylight-saving change", () => {
    // 04.10.2026 is 23 hours long: midnight +10, next midnight +11.
    const w = windowForDays({ year: 2026, month: 10, day: 4 }, { year: 2026, month: 10, day: 4 });
    expect(w.from.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-04T13:00:00.000Z");
  });

  it("is last Monday to Sunday when the timer fires on Monday morning", () => {
    // Monday 12.10.2026 08:00 Melbourne.
    const w = previousWeek(new Date("2026-10-11T21:00:00Z"));
    expect(w.label).toBe("05.10-11.10");
    expect(w.to.toISOString()).toBe("2026-10-11T13:00:00.000Z");
  });

  it("is still the last finished week when run late in the week", () => {
    expect(previousWeek(new Date("2026-10-15T02:00:00Z")).label).toBe("05.10-11.10");
  });

  it("crosses a month and a year", () => {
    expect(previousWeek(new Date("2027-01-04T00:00:00Z")).label).toBe("28.12-03.01");
  });
});

describe("countForManager", () => {
  const week = windowForDays({ year: 2026, month: 10, day: 5 }, { year: 2026, month: 10, day: 11 });

  it("counts only the three report types, only this manager's, only in the window", () => {
    const histories = [
      history({ historyTypeID: 1 }),
      history({ historyTypeID: 1 }),
      history({ historyTypeID: 16 }),
      history({ historyTypeID: 6 }),
      history({ historyTypeID: 0 }), // Call Attempted: not reported
      history({ historyTypeID: 83 }), // Email Sends (marketing tool): not reported
      history({ historyTypeID: 16, recordManagerID: CHRIS }),
      history({ historyTypeID: 1, startTime: "2026-10-04T12:59:59Z" }), // Sunday 23:59 before
      history({ historyTypeID: 1, startTime: "2026-10-11T13:00:00Z" }), // next Monday 00:00
    ];
    const counts = countForManager(BRANDON, histories, [], week);
    expect(counts.activities).toEqual({ 1: 2, 16: 1, 6: 1 });
    expect(countForManager(CHRIS, histories, [], week).activities).toEqual({ 1: 0, 16: 1, 6: 0 });
  });

  it("counts a record returned twice by paging once", () => {
    const h = history({ historyTypeID: 16 });
    expect(countForManager(BRANDON, [h, h], [], week).activities[16]).toBe(1);
  });

  it("falls back to created when a history record has no startTime", () => {
    const h = history({ startTime: null, created: "2026-10-07T00:00:00Z" });
    expect(countForManager(BRANDON, [h], [], week).activities[1]).toBe(1);
  });

  it("counts prospects created in the window, owned by the manager, still Prospect", () => {
    const contacts = [
      contact({}),
      contact({ idStatus: "Customer" }),
      contact({ recordManagerID: CHRIS }),
      contact({ created: "2026-09-30T00:00:00Z" }), // edited this week, created before
      contact({ contactType: "My Record" }),
    ];
    expect(countForManager(BRANDON, [], contacts, week).prospects).toBe(1);
  });

  it("lists every type in the window for the dry-run breakdown", () => {
    const histories = [
      history({ historyTypeID: 0, historyType: { id: 0, name: "Call Attempted" } }),
      history({ historyTypeID: 0, historyType: { id: 0, name: "Call Attempted" } }),
      history({ historyTypeID: 16, historyType: { id: 16, name: "E-mail Sent" } }),
    ];
    expect(historyTypeBreakdown(BRANDON, histories, week)).toEqual([
      { id: 0, name: "Call Attempted", count: 2 },
      { id: 16, name: "E-mail Sent", count: 1 },
    ]);
  });
});

describe("resolveManager", () => {
  const users = [
    { id: BRANDON, displayName: "Brandon Clark", firstName: "Brandon", email: "brandon.clark@pathfindercut.com" },
    { id: CHRIS, displayName: "Chris Gilmartin", firstName: null, email: null },
  ] as unknown as ActUser[];

  it("joins on the exact display name and takes the Act! email", () => {
    const r = resolveManager({ actUser: "Brandon Clark", cc: [" boss@x.com ", "", "brandon.clark@pathfindercut.com"] }, users);
    expect(r).toEqual({
      ok: true,
      manager: {
        actUserId: BRANDON,
        displayName: "Brandon Clark",
        firstName: "Brandon",
        to: "brandon.clark@pathfindercut.com",
        cc: ["boss@x.com"],
      },
    });
  });

  it("refuses a near match", () => {
    expect(resolveManager({ actUser: "brandon clark", cc: [] }, users).ok).toBe(false);
  });

  it("refuses a user with no email unless one is configured", () => {
    expect(resolveManager({ actUser: "Chris Gilmartin", cc: [] }, users).ok).toBe(false);
    const r = resolveManager({ actUser: "Chris Gilmartin", to: "chris@pathfindercut.com", cc: [] }, users);
    expect(r.ok && r.manager.firstName).toBe("Chris");
  });
});

describe("the email", () => {
  it("follows the hand-written report, with the numbers in a table", () => {
    const email = buildWeeklyReportEmail({
      firstName: "Brandon",
      window: windowForDays({ year: 2026, month: 8, day: 31 }, { year: 2026, month: 9, day: 7 }),
      counts: { activities: { 1: 2, 16: 19, 6: 2 }, prospects: 0 },
    });
    expect(email.subject).toBe("Weekly activity report");
    expect(email.text).toBe(
      [
        "Hi Brandon!",
        "",
        "I hope you are very well.",
        "",
        "Here are your weekly activities (31.08-07.09):",
        "",
        "Call Completed: 2",
        "E-mail Sent: 19",
        "Meeting Held: 2",
        "Prospects generated: 0",
      ].join("\n"),
    );
    expect(email.html).toContain("<table");
    expect(email.html).toContain(">E-mail Sent</td>");
    expect(email.html).toContain(">19</td>");
  });

  it("sends from the Resend address under the marketing name", () => {
    expect(reportFromAddress("PathQuote <noreply@q.pathfindercut.com>", "Pathfinder Marketing")).toBe(
      "Pathfinder Marketing <noreply@q.pathfindercut.com>",
    );
    expect(reportFromAddress("noreply@q.pathfindercut.com", "X")).toBe("X <noreply@q.pathfindercut.com>");
  });
});

describe("parseWeeklyReportArgs", () => {
  const monday = new Date("2026-10-11T21:00:00Z");

  it("defaults to last week, sending for real", () => {
    const r = parseWeeklyReportArgs([], monday);
    expect(r.ok && r.args.window.label).toBe("05.10-11.10");
    expect(r.ok && r.args.dryRun).toBe(false);
  });

  it("takes an explicit period and a test address", () => {
    const r = parseWeeklyReportArgs(
      ["--dry-run", "--from", "2026-10-04", "--to=2026-10-11", "--send-to", "me@x.com"],
      monday,
    );
    expect(r.ok && r.args).toMatchObject({ dryRun: true, sendTo: "me@x.com" });
    expect(r.ok && r.args.window.label).toBe("04.10-11.10");
  });

  it.each([
    [["--from", "2026-10-04"]],
    [["--from", "2026-10-11", "--to", "2026-10-04"]],
    [["--from", "2026-02-30", "--to", "2026-03-01"]],
    [["--send-to", "nobody"]],
    [["--to", "--dry-run"]],
    [["--verbose"]],
  ])("refuses %j", (argv) => {
    expect(parseWeeklyReportArgs(argv, monday).ok).toBe(false);
  });

  it("refuses when npm kept --dry-run for itself", () => {
    const r = parseWeeklyReportArgs([], monday, { npm_config_dry_run: "true" });
    expect(r.ok).toBe(false);
  });
});
