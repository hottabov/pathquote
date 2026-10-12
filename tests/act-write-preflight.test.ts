import { describe, it, expect } from "vitest";
import {
  ActApiError,
  ActClient,
  COUNTRIES_PICKLIST_ID,
  REP_PICKLIST_ID,
  ActNoAnswerError,
  LOOKUP_TOP,
  historyRegardingFilter,
  lookupQuery,
  opportunityNameFilter,
} from "../src/lib/act/client";
import { transcribedStages } from "../src/lib/act/opportunity-stages";
import { OPPORTUNITY_NAME_MAX } from "../src/lib/act/write-payloads";
import {
  DOCUMENTED_SERVICE_ACCOUNT_ID,
  PRODUCT_PROBES,
  backlogCheck,
  backlogState,
  countriesCheck,
  countryCoverage,
  drainTimerCheck,
  formatPreflightReport,
  historyFilterCheck,
  historyProbeContacts,
  notAsked,
  opportunityFilterCheck,
  preflightExitStatus,
  productLinesCheck,
  productProbeCandidates,
  readFailure,
  repPicklistCheck,
  sampleOpportunity,
  serviceAccountCheck,
  transcribedCheck,
  usersMappedCheck,
  type BacklogRow,
  type Check,
  type PathQuoteUser,
  type Read,
  type ReadFailure,
  type Row,
} from "../src/lib/act/write-preflight";
import { formatWritePreflightBanner, parseWritePreflightArgs } from "../src/lib/act/write-preflight-args";

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const failed = (failure: Partial<ReadFailure> = {}): Read<never> => ({
  ok: false,
  failure: { message: "boom", status: 500, filterRefused: false, ...failure },
});

describe("the reader the preflight holds", () => {
  const client = new ActClient({ baseUrl: "http://127.0.0.1:9", database: "D", username: "Marketing", password: "x" });

  it("has a GET for each of its four members and nothing else: no create, update or other write is reachable from it", () => {
    const reader = client.reader();
    expect(Object.keys(reader).sort()).toEqual(["loginName", "picklistItems", "rows", "users"]);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(reader.loginName).toBe("Marketing");
    for (const name of ["createContact", "createOpportunity", "createHistory", "updateContact", "updateOpportunity", "createProductLine", "updateProductLine"]) {
      expect(name in reader).toBe(false);
    }
  });

  it("refuses anything but a path under /api/, before any request", async () => {
    const reader = client.reader();
    await expect(reader.rows("http://elsewhere/api/x")).rejects.toThrow(/path under \/api\//);
    await expect(reader.rows("/authorize")).rejects.toThrow(/path under \/api\//);
    await expect(reader.rows("/api/opportunities?$top=1")).rejects.toThrow(/no query of its own/);
  });

  it("asks what the drain's lookups ask: $top of LOOKUP_TOP, and the same filters", () => {
    expect(LOOKUP_TOP).toBe(1000);
    expect(lookupQuery().toString()).toBe("%24top=1000");
    expect(lookupQuery(opportunityNameFilter("Q-AU-2026-001 AUD")).toString()).toBe(
      "%24top=1000&%24filter=name+eq+%27Q-AU-2026-001+AUD%27",
    );
    expect(historyRegardingFilter("O'Brien")).toBe("regarding eq 'O''Brien'");
  });
});

describe("readFailure", () => {
  it("keeps ACT!'s status, and says whether the lookup would fall back on it", () => {
    expect(readFailure(new ActApiError("no", "GET", 400, "", "refused"))).toEqual({ message: "no", status: 400, filterRefused: true });
    expect(readFailure(new ActApiError("no", "GET", 401, "", "refused")).filterRefused).toBe(false);
    expect(readFailure(new ActApiError("no", "GET", 503, "", "failed"))).toMatchObject({ status: 503, filterRefused: false });
    expect(readFailure(new ActNoAnswerError("GET /api/users", 3, "timed out"))).toMatchObject({ status: null, filterRefused: false });
    expect(readFailure("odd")).toEqual({ message: "odd", status: null, filterRefused: false });
  });
});

describe("parseWritePreflightArgs", () => {
  it("takes nothing", () => {
    expect(parseWritePreflightArgs([])).toEqual({ ok: true });
  });

  it("refuses every argument, --apply and --dry-run included: it never writes, so a flag would mislead", () => {
    for (const argv of [["--apply"], ["--dry-run"], ["x"]]) {
      const parsed = parseWritePreflightArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("takes no arguments");
    }
  });

  it("refuses a flag npm swallowed, from the trace it leaves", () => {
    const apply = { npm_config_all: "true", npm_config_parseable: "true", npm_config_long: "true", npm_config_yes: "true" };
    expect(parseWritePreflightArgs([], apply)).toMatchObject({ ok: false });
    expect(parseWritePreflightArgs([], { npm_config_dry_run: "true" })).toMatchObject({ ok: false });
    expect(parseWritePreflightArgs([], { npm_config_dry_run: "" })).toEqual({ ok: true });
  });

  it("says in its banner that it writes nothing, and never prints the password", () => {
    const banner = formatWritePreflightBanner({ host: "postgres", port: "5432", name: "pathquote" }, { base: "https://act/api", login: "Marketing" });
    expect(banner).toContain("READ-ONLY");
    expect(banner).toContain("postgres:5432/pathquote");
    expect(banner).toContain('"Marketing"');
  });
});

describe("1 serviceAccountCheck", () => {
  const user = (over: Row = {}): Row => ({
    id: DOCUMENTED_SERVICE_ACCOUNT_ID,
    username: "Marketing",
    role: "Manager",
    status: "Active",
    ...over,
  });

  it("passes the Active Manager ACT_USER names, found as the drain finds it -- trimmed, any case", () => {
    const check = serviceAccountCheck(ok([user(), user({ id: "u2", username: "Wayne" })]), " marketing ");
    expect(check).toMatchObject({ number: 1, status: "PASS" });
    expect(check.details.join(" ")).not.toContain("Not the id");
  });

  it("says so when the account found is not the one the reference records", () => {
    const check = serviceAccountCheck(ok([user({ id: "aaaaaaaa-0000-0000-0000-000000000000" })]), "Marketing");
    expect(check.status).toBe("PASS");
    expect(check.details.join(" ")).toContain("Not the id");
  });

  it("fails Browse and Standard, warns Administrator and an unknown role", () => {
    expect(serviceAccountCheck(ok([user({ role: "Browse" })]), "Marketing")).toMatchObject({ status: "FAIL" });
    expect(serviceAccountCheck(ok([user({ role: "Browse" })]), "Marketing").reason).toContain("read-only");
    expect(serviceAccountCheck(ok([user({ role: "Standard" })]), "Marketing")).toMatchObject({ status: "FAIL" });
    expect(serviceAccountCheck(ok([user({ role: "Administrator" })]), "Marketing")).toMatchObject({ status: "WARN" });
    expect(serviceAccountCheck(ok([user({ role: "Wizard" })]), "Marketing")).toMatchObject({ status: "WARN" });
    expect(serviceAccountCheck(ok([user({ role: null })]), "Marketing")).toMatchObject({ status: "WARN" });
  });

  it("fails an account that is not Active", () => {
    const check = serviceAccountCheck(ok([user({ status: "Inactive" })]), "Marketing");
    expect(check.status).toBe("FAIL");
    expect(check.reason).toContain("Inactive");
  });

  it("fails none found, and more than one: the drain stops every pass for either", () => {
    expect(serviceAccountCheck(ok([user({ username: "Other" })]), "Marketing")).toMatchObject({ status: "FAIL" });
    const two = serviceAccountCheck(ok([user(), user({ id: "u2", username: "MARKETING" })]), "Marketing");
    expect(two.status).toBe("FAIL");
    expect(two.reason).toContain("2 ACT! users");
  });

  it("fails a users lookup that failed, with what to look at for its status", () => {
    expect(serviceAccountCheck(failed({ status: 401 }), "M").todo.join(" ")).toContain("ACT_PASS");
    expect(serviceAccountCheck(failed({ status: 403 }), "M").todo.join(" ")).toContain("allow-list");
    expect(serviceAccountCheck(failed({ status: null }), "M").todo.join(" ")).toContain("ACT_BASE");
    expect(serviceAccountCheck(failed(), "M").status).toBe("FAIL");
  });
});

const pqUser = (over: Partial<PathQuoteUser> = {}): PathQuoteUser => ({
  email: "a@pathfindercut.com",
  role: "MANAGER",
  active: true,
  actUserId: "act-a",
  actAccountMgr: "Wayne Walker",
  ...over,
});

describe("2 usersMappedCheck", () => {
  it("passes when every active user is mapped; inactive ones are not counted", () => {
    expect(usersMappedCheck([pqUser(), pqUser({ email: "old@x", active: false, actUserId: null })])).toMatchObject({ status: "PASS" });
  });

  it("warns, listing each unmapped user by email and what their contacts get", () => {
    const check = usersMappedCheck([
      pqUser(),
      pqUser({ email: "dist@reseller.example", actUserId: null, actAccountMgr: null }),
      pqUser({ email: "achim@degel.example", actUserId: null, actAccountMgr: "Achim Degel" }),
    ]);
    expect(check.status).toBe("WARN");
    expect(check.reason).toContain("2 of 3 active users have no ACT! user");
    expect(check.details).toEqual([
      "dist@reseller.example (MANAGER) -- a contact created for their quote gets no Account Mgr",
      'achim@degel.example (MANAGER) -- a contact created for their quote gets Account Mgr "Achim Degel"',
    ]);
    expect(check.todo.join(" ")).toContain("npm run act:map-users");
  });
});

describe("3 repPicklistCheck", () => {
  const items = ok([{ value: "Wayne Walker" }, { value: "Achim Degel" }]);

  it("passes every value on the list, exactly", () => {
    expect(repPicklistCheck(items, [pqUser(), pqUser({ actUserId: null, actAccountMgr: "Achim Degel" })]).status).toBe("PASS");
  });

  it("fails a value off the list -- case counts, as on a limit-to-list picklist -- an inactive user's included", () => {
    const check = repPicklistCheck(items, [pqUser({ actAccountMgr: "wayne walker" }), pqUser({ email: "old@x", active: false, actAccountMgr: "Gone" })]);
    expect(check.status).toBe("FAIL");
    expect(check.details).toContain('a@pathfindercut.com: "wayne walker"');
    expect(check.details).toContain('old@x: "Gone"');
  });

  it("warns for an active distributor with no Account Mgr: written with none", () => {
    const check = repPicklistCheck(items, [pqUser(), pqUser({ email: "d@x", actUserId: null, actAccountMgr: null })]);
    expect(check.status).toBe("WARN");
    expect(check.details).toContain("d@x (MANAGER)");
  });

  it("fails a list it could not read, and suspects the pinned id on a 404", () => {
    const check = repPicklistCheck(failed({ status: 404 }), [pqUser()]);
    expect(check.status).toBe("FAIL");
    expect(check.todo.join(" ")).toContain("REP_PICKLIST_ID");
  });
});

describe("4 countryCoverage and countriesCheck", () => {
  const items = [{ value: "Australia" }, { value: "United States" }, { value: "USA" }];

  it("counts by the ISO code each stored value reads as, through the drain's own match", () => {
    const coverage = countryCoverage(
      [
        { country: "AU", companies: 40, contactsNotInAct: 3 },
        { country: "Australia", companies: 2, contactsNotInAct: 1 },
        { country: "US", companies: 10, contactsNotInAct: 0 },
        { country: "NZ", companies: 5, contactsNotInAct: 2 },
        { country: "DE", companies: 7, contactsNotInAct: 1 },
        { country: null, companies: 4, contactsNotInAct: 4 },
        { country: "Narnia", companies: 1, contactsNotInAct: 0 },
      ],
      items,
    );
    expect(coverage.present).toBe(4);
    expect(coverage.covered).toBe(2);
    expect(coverage.misses).toEqual([
      { iso: "DE", name: "Germany", companies: 7, contactsNotInAct: 1 },
      { iso: "NZ", name: "New Zealand", companies: 5, contactsNotInAct: 2 },
    ]);
    expect(coverage.unreadable).toEqual([
      { country: null, companies: 4, contactsNotInAct: 4 },
      { country: "Narnia", companies: 1, contactsNotInAct: 0 },
    ]);
  });

  it("passes when every country present has an item, whatever the list lacks besides", () => {
    const check = countriesCheck(ok(items), [{ country: "AU", companies: 1, contactsNotInAct: 1 }]);
    expect(check.status).toBe("PASS");
  });

  it("warns for a miss, naming it with its counts, and says what a refused create costs", () => {
    const check = countriesCheck(ok(items), [{ country: "NZ", companies: 5, contactsNotInAct: 2 }]);
    expect(check.status).toBe("WARN");
    expect(check.details).toContain("missing NZ New Zealand: 5 companies, 2 contacts not yet in ACT!");
    expect(check.todo.join(" ")).toContain("isAllowBlank");
  });

  it("warns for companies whose country PathQuote cannot read, and for an empty list", () => {
    expect(countriesCheck(ok(items), [{ country: null, companies: 3, contactsNotInAct: 0 }]).status).toBe("WARN");
    const empty = countriesCheck(ok([]), [{ country: "AU", companies: 1, contactsNotInAct: 0 }]);
    expect(empty.status).toBe("WARN");
    expect(empty.reason).toContain("empty");
  });

  it("fails a list it could not read", () => {
    expect(countriesCheck(failed({ status: 404 }), []).todo.join(" ")).toContain("COUNTRIES_PICKLIST_ID");
  });
});

describe("5 opportunityFilterCheck", () => {
  const page = ok<Row[]>([{ id: "o-blank", name: "" }, { id: "o1", name: "Q-AU-2026-001 AUD" }]);
  const opportunity = { id: "o1", name: "Q-AU-2026-001 AUD" };

  it("picks the first opportunity with an id and a name as the real name to try", () => {
    expect(sampleOpportunity(page.ok ? page.value : [])).toEqual(opportunity);
    expect(sampleOpportunity([{ id: "x" }, { name: "y" }])).toBeNull();
  });

  it("passes zero rows for nonsense and exactly the real name's rows", () => {
    const check = opportunityFilterCheck({ nonsense: ok([]), page, sample: { opportunity, rows: ok([{ id: "o1", name: "Q-AU-2026-001 AUD" }]) } });
    expect(check.status).toBe("PASS");
  });

  it("allows rows that differ only in case, and says the drain leaves them out", () => {
    const check = opportunityFilterCheck({
      nonsense: ok([]),
      page,
      sample: { opportunity, rows: ok([{ id: "o1", name: "Q-AU-2026-001 AUD" }, { id: "o2", name: "q-au-2026-001 aud" }]) },
    });
    expect(check.status).toBe("PASS");
    expect(check.details.join(" ")).toContain("only in case");
  });

  it("fails rows for a name nobody has: the filter is ignored", () => {
    const check = opportunityFilterCheck({ nonsense: ok([{ id: "o1", name: "x" }]), page, sample: null });
    expect(check.status).toBe("FAIL");
    expect(check.reason).toContain("ignored $filter");
    expect(check.details[0]).toContain(`from ${LOOKUP_TOP.toLocaleString("en-US")} opportunities on`);
  });

  it("says a full page of ignored rows is every create refused now", () => {
    const rows = Array.from({ length: LOOKUP_TOP }, (_, i) => ({ id: `o${i}`, name: `n${i}` }));
    const check = opportunityFilterCheck({ nonsense: ok(rows), page, sample: null });
    expect(check.status).toBe("FAIL");
    expect(check.details[0]).toContain("full page");
  });

  it("fails a real name that brings back another name, or misses the opportunity asked for", () => {
    expect(
      opportunityFilterCheck({ nonsense: ok([]), page, sample: { opportunity, rows: ok([{ id: "o1", name: opportunity.name }, { id: "o9", name: "other" }]) } }).status,
    ).toBe("FAIL");
    const missed = opportunityFilterCheck({ nonsense: ok([]), page, sample: { opportunity, rows: ok([]) } });
    expect(missed.status).toBe("FAIL");
    expect(missed.reason).toContain("create a second");
  });

  it("warns a filter ACT! refuses: the drain falls back to the contact's opportunities", () => {
    const check = opportunityFilterCheck({ nonsense: failed({ status: 400, filterRefused: true }), page, sample: null });
    expect(check.status).toBe("WARN");
    expect(check.reason).toContain("falls back");
  });

  it("fails a lookup that failed, and warns an ACT! with no opportunity to try", () => {
    expect(opportunityFilterCheck({ nonsense: failed(), page, sample: null }).status).toBe("FAIL");
    expect(opportunityFilterCheck({ nonsense: ok([]), page: failed(), sample: null }).status).toBe("FAIL");
    expect(opportunityFilterCheck({ nonsense: ok([]), page: ok([]), sample: null }).status).toBe("WARN");
  });
});

describe("6 productProbeCandidates and productLinesCheck", () => {
  it("asks the priced opportunities first, at most PRODUCT_PROBES", () => {
    const page: Row[] = [
      { id: "a", name: "A", productTotal: 0 },
      { id: "b", name: "B", productTotal: 1200 },
      { id: null, name: "no id", productTotal: 5 },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `z${i}`, name: `Z${i}` })),
    ];
    const candidates = productProbeCandidates(page);
    expect(candidates[0]).toEqual({ id: "b", name: "B" });
    expect(candidates[1]).toEqual({ id: "a", name: "A" });
    expect(candidates).toHaveLength(PRODUCT_PROBES);
  });

  const opportunity = { id: "b", name: "B" };

  it("passes lines that carry itemNumber, empty or not", () => {
    const check = productLinesCheck(ok([]), [
      { opportunity: { id: "a", name: "A" }, lines: ok([]) },
      { opportunity, lines: ok([{ id: "l1", itemNumber: "Q-AU-2026-001" }, { id: "l2", itemNumber: null }]) },
    ]);
    expect(check.status).toBe("PASS");
  });

  it("fails a line with no itemNumber property at all", () => {
    const check = productLinesCheck(ok([]), [{ opportunity, lines: ok([{ id: "l1", name: "x" }]) }]);
    expect(check.status).toBe("FAIL");
    expect(check.reason).toContain("doubling");
    expect(check.details).toContain("line l1: itemNumber absent");
  });

  it("warns when no opportunity asked has a line, and fails when the asking failed", () => {
    expect(productLinesCheck(ok([]), [{ opportunity, lines: ok([]) }]).status).toBe("WARN");
    expect(productLinesCheck(ok([]), []).status).toBe("WARN");
    expect(productLinesCheck(ok([]), [{ opportunity, lines: failed() }]).status).toBe("FAIL");
    expect(productLinesCheck(failed(), []).status).toBe("FAIL");
  });
});

describe("7 historyProbeContacts and historyFilterCheck", () => {
  it("takes each contact on the opportunities once", () => {
    expect(
      historyProbeContacts([{ contacts: [{ id: "c1" }, { id: "C1" }] }, { contacts: null }, { contacts: [{ id: "c2" }, {}] }]),
    ).toEqual(["c1", "c2"]);
  });

  const page = ok<Row[]>([]);
  const probes = [
    { contactId: "c0", history: ok<Row[]>([]) },
    { contactId: "c1", history: ok<Row[]>([{ id: "h" }]) },
  ];

  it("passes zero rows for a regarding nobody has, on a contact that has History", () => {
    const check = historyFilterCheck({ page, probes, filtered: ok([]) });
    expect(check.status).toBe("PASS");
    expect(check.details).toEqual(["contact tried: c1"]);
  });

  it("warns an ignored filter or a refused one, with what a contact with a full page of History costs", () => {
    const ignored = historyFilterCheck({ page, probes, filtered: ok([{ id: "h" }]) });
    expect(ignored.status).toBe("WARN");
    expect(ignored.todo.join(" ")).toContain("full page");
    expect(historyFilterCheck({ page, probes, filtered: failed({ status: 400, filterRefused: true }) }).status).toBe("WARN");
  });

  it("warns, inconclusive, with no contact that has History; fails a read that failed", () => {
    expect(historyFilterCheck({ page, probes: [probes[0]], filtered: null }).status).toBe("WARN");
    expect(historyFilterCheck({ page, probes: [{ contactId: "c", history: failed() }], filtered: null }).status).toBe("FAIL");
    expect(historyFilterCheck({ page, probes, filtered: failed() }).status).toBe("FAIL");
    expect(historyFilterCheck({ page: failed(), probes: [], filtered: null }).status).toBe("FAIL");
  });
});

describe("8 backlogCheck", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const row = (over: Partial<BacklogRow> = {}): BacklogRow => ({
    documentId: "d1",
    number: "Q-AU-2026-001",
    status: "FINAL",
    companyName: "Fielding Signs",
    authorEmail: "a@pathfindercut.com",
    createdAt: new Date("2026-10-12T01:00:00Z"),
    nextAttemptAt: new Date("2026-10-12T01:00:00Z"),
    attempts: 0,
    blockedReason: null,
    blockedBy: null,
    ...over,
  });

  it("sorts each row by where it stands", () => {
    expect(backlogState(row(), now)).toBe("due");
    expect(backlogState(row({ nextAttemptAt: new Date("2026-10-13T01:00:00Z") }), now)).toBe("backing off");
    expect(backlogState(row({ blockedReason: "r" }), now)).toBe("held by PathQuote");
    expect(backlogState(row({ blockedReason: "r", blockedBy: "contact" }), now)).toBe("held for its contact");
    expect(backlogState(row({ blockedReason: "r", blockedBy: "drain" }), now)).toBe("held, duplicates in ACT!");
    expect(backlogState(row({ blockedReason: "r", blockedBy: "act" }), now)).toBe("held, ACT! refused");
    expect(backlogState(row({ blockedReason: "r", blockedBy: "revision" }), now)).toBe("held, unreadable revision");
  });

  it("passes off with nothing queued, and on with nothing held", () => {
    expect(backlogCheck(false, [], now).status).toBe("PASS");
    expect(backlogCheck(true, [row()], now).status).toBe("PASS");
  });

  it("warns off with rows queued, listing every quote switching on sends, oldest first, for test quotes to be taken out", () => {
    const check = backlogCheck(
      false,
      [
        row({ documentId: "d2", number: "Q-AU-2026-002", createdAt: new Date("2026-10-12T02:00:00Z"), blockedReason: "r", blockedBy: "act" }),
        row(),
        row({ documentId: "d3", number: "Q-US-2026-003", createdAt: new Date("2026-10-12T03:00:00Z"), nextAttemptAt: new Date("2026-10-13T02:00:00Z"), attempts: 2 }),
      ],
      now,
    );
    expect(check.status).toBe("WARN");
    expect(check.reason).toContain("3 quotes are queued");
    expect(check.details[0]).toBe("sending is OFF (Setting act.write.enabled)");
    expect(check.details[1]).toBe("3 unfinished rows: 1 due, 1 held, ACT! refused, 1 backing off");
    expect(check.reason).toContain("switching it on sends 2 on their own, and 1 once what holds it is settled");
    expect(check.details[2]).toContain("Sent on their own once switched on");
    expect(check.details[3]).toContain("Q-AU-2026-001  FINAL  Fielding Signs  by a@pathfindercut.com  queued 2026-10-12 01:00 UTC  due  /quotes/d1");
    expect(check.details[4]).toContain("Q-US-2026-003");
    expect(check.details[4]).toContain("backing off, 2 failed attempts");
    expect(check.details[5]).toBe("Held, sent once what holds them is settled:");
    expect(check.details[6]).toContain("Q-AU-2026-002");
    expect(check.todo.join(" ")).toContain("Don't send this quote to ACT!");
  });

  it("warns on with a row held", () => {
    expect(backlogCheck(true, [row({ blockedReason: "r", blockedBy: "contact" })], now).status).toBe("WARN");
  });
});

describe("9 drainTimerCheck", () => {
  it("is INFO, and says where to look on the host", () => {
    const check = drainTimerCheck();
    expect(check.status).toBe("INFO");
    expect(check.details).toContain("systemctl list-timers 'pq-act-*'");
  });
});

describe("10 transcribedCheck", () => {
  const live = (): Row[] =>
    transcribedStages().map((stage) => ({
      id: stage.id,
      name: stage.name,
      number: stage.number,
      probability: stage.probability,
      process: { id: stage.processId, name: "p" },
    }));
  const fieldRows = (): Row[] => [
    { recordType: "Contact", name: "name", length: 64 },
    { recordType: "Opportunity", name: "name", length: OPPORTUNITY_NAME_MAX },
    { recordType: "Contact", name: "customFields/rep", picklist: { id: REP_PICKLIST_ID, name: "Rep" } },
    { recordType: "Contact", name: "businessAddress/country", picklist: { id: COUNTRIES_PICKLIST_ID, name: "Countries" } },
  ];
  const fields = ok(fieldRows());

  it("passes stages and the name length as transcribed", () => {
    expect(transcribedStages()).toHaveLength(4);
    expect(transcribedCheck(ok(live()), fields).status).toBe("PASS");
  });

  it("fails a stage that is gone or in another process, and lists what ACT! has for the table", () => {
    const gone = transcribedCheck(ok(live().slice(1)), fields);
    expect(gone.status).toBe("FAIL");
    expect(gone.details).toContain("ACT!'s stages in those processes now:");
    expect(gone.details.filter((line) => line.startsWith("  process "))).toHaveLength(3);
    const moved = live();
    moved[0] = { ...moved[0], process: { id: "other" } };
    expect(transcribedCheck(ok(moved), fields).status).toBe("FAIL");
  });

  it("warns a stage renamed or renumbered, a name length changed, and fields it could not read", () => {
    const renamed = live();
    renamed[0] = { ...renamed[0], number: 99 };
    expect(transcribedCheck(ok(renamed), fields).status).toBe("WARN");
    expect(transcribedCheck(ok(live()), ok([{ recordType: "Opportunity", name: "name", length: 50 }])).status).toBe("WARN");
    expect(transcribedCheck(ok(live()), failed()).status).toBe("WARN");
  });

  it("warns a picklist id that is no longer the pinned one, naming the new one", () => {
    const moved = fieldRows();
    moved[2] = { ...moved[2], picklist: { id: "11111111-2222-3333-4444-555555555555", name: "Rep 2" } };
    const check = transcribedCheck(ok(live()), ok(moved));
    expect(check.status).toBe("WARN");
    expect(check.reason).toContain("11111111-2222-3333-4444-555555555555");
    expect(check.reason).toContain("REP_PICKLIST_ID");
    expect(transcribedCheck(ok(live()), ok(fieldRows().slice(0, 3))).status).toBe("WARN");
    expect(transcribedCheck(failed(), fields).status).toBe("FAIL");
  });
});

describe("the report", () => {
  const check = (status: Check["status"]): Check => ({ number: 1, title: "T", status, reason: "r", details: ["d"], todo: status === "PASS" ? [] : ["t"] });

  it("exits 1 for any FAIL, 0 otherwise", () => {
    expect(preflightExitStatus([check("PASS"), check("WARN"), check("INFO")])).toBe(0);
    expect(preflightExitStatus([check("PASS"), check("FAIL")])).toBe(1);
    expect(preflightExitStatus([notAsked(5, "x")])).toBe(1);
  });

  it("prints each check with its status, details and what to do, then the tally", () => {
    const lines = formatPreflightReport([check("PASS"), check("FAIL")]);
    expect(lines[0]).toBe("[PASS] 1. T: r");
    expect(lines[1]).toBe("         d");
    expect(lines).toContain("       do: t");
    expect(lines).toContain("1 PASS, 0 WARN, 1 FAIL, 0 INFO");
    expect(lines.at(-1)).toBe("Nothing was written to ACT! or to PathQuote.");
  });
});
