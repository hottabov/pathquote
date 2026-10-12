import { describe, it, expect } from "vitest";
import {
  HISTORY_TYPE_QUOTE,
  OPPORTUNITY_STATUS,
  historyBody,
  lostOpportunityBody,
  moneyWithCode,
  newOpportunityBody,
  revisedOpportunityBody,
  wonOpportunityBody,
  type QuoteForAct,
  type ActParties,
} from "../src/lib/act/write-payloads";
import { sentStage, wonStage } from "../src/lib/act/opportunity-stages";

const SALES_CYCLE = "2380e83d-cef4-4b6d-ad15-dc9a558431ab";
const US_PROCESS = "26ab3a1e-ff20-406d-a0b4-3b351955da45";

const CONTACT = "c0000000-0000-0000-0000-000000000001";
const COMPANY = "c0000000-0000-0000-0000-0000000000c0";
const OPPORTUNITY = "c0000000-0000-0000-0000-0000000000a0";
const AUTHOR = "a0000000-0000-0000-0000-000000000001";
const SERVICE = "d90f208e-e1fd-4835-8811-541b0c4b81b9";

const FINALISED = new Date("2026-10-12T04:30:00.000Z");

const quote = (overrides: Partial<QuoteForAct> = {}): QuoteForAct => ({
  number: "Q-AU-2026-014",
  revision: 1,
  regionCode: "AU",
  total: 45000,
  currency: "AUD",
  validityDays: 30,
  finalizedAt: FINALISED,
  ...overrides,
});

const parties = (overrides: Partial<ActParties> = {}): ActParties => ({
  contactActId: CONTACT,
  companyActId: null,
  authorActUserId: AUTHOR,
  serviceAccountUserId: SERVICE,
  ...overrides,
});

describe("historyBody", () => {
  it("records a finalised quote against its contact, owned by the author", () => {
    const body = historyBody(quote(), parties(), null);
    expect(body.historyTypeID).toBe(62);
    expect(HISTORY_TYPE_QUOTE).toBe(62);
    expect(body.regarding).toContain("Q-AU-2026-014");
    expect(body.details).toContain("AUD 45,000.00");
    expect(body.details).toContain("30 days");
    expect(body.details).toContain("Revision 1");
    expect(body.startTime).toBe("2026-10-12T04:30:00.000Z");
    expect(body.contacts).toEqual([{ id: CONTACT }]);
    expect(body.recordManagerID).toBe(AUTHOR);
  });

  it("says a one-day validity in the singular", () => {
    expect(historyBody(quote({ validityDays: 1 }), parties(), null).details).toContain("Valid for 1 day\n");
  });

  it("names the revision label, not only the number, once there has been a revision", () => {
    expect(historyBody(quote({ revision: 2 }), parties(), null).regarding).toContain("Q-AU-2026-014-R2");
    expect(historyBody(quote({ revision: 0 }), parties(), null).regarding).not.toContain("-R0");
  });

  it("falls back to the service account when the author is not mapped to an ACT! user", () => {
    const body = historyBody(quote(), parties({ authorActUserId: null }), null);
    expect(body.recordManagerID).toBe(SERVICE);
    // Nothing else in the body claims a person: no second user id anywhere.
    expect(body).not.toHaveProperty("manageUserID");
    expect(body).not.toHaveProperty("createUserID");
    expect(JSON.stringify(body)).not.toContain(AUTHOR);
  });

  it("links the opportunity when there is one", () => {
    expect(historyBody(quote(), parties(), OPPORTUNITY).opportunities).toEqual([{ id: OPPORTUNITY }]);
    expect(historyBody(quote(), parties(), null)).not.toHaveProperty("opportunities");
  });

  it("links the company only when it has an ACT! id", () => {
    expect(historyBody(quote(), parties({ companyActId: COMPANY }), null).companies).toEqual([{ id: COMPANY }]);
    expect(historyBody(quote(), parties(), null)).not.toHaveProperty("companies");
  });
});

describe("newOpportunityBody", () => {
  it("opens an opportunity at the region's sent stage, named with its currency", () => {
    const body = newOpportunityBody(quote(), parties());
    expect(body.name).toContain("Q-AU-2026-014");
    expect(body.name).toContain("AUD");
    expect(body.name).toContain("45,000.00");
    expect(body.name).toBe("Q-AU-2026-014 — AUD 45,000.00");
    expect(body.stage).toMatchObject({ id: sentStage("AU")!.id, process: { id: SALES_CYCLE } });
    expect(body.probability).toBe(sentStage("AU")!.probability);
    expect(body.status).toBe(OPPORTUNITY_STATUS.open);
    expect(body.openDate).toBe("2026-10-12T04:30:00.000Z");
    expect(body.contacts).toEqual([{ id: CONTACT }]);
    expect(body.productTotal).toBe(45000);
    expect(body.recordManagerID).toBe(AUTHOR);
  });

  it("puts a US quote on the US process with its own currency", () => {
    const body = newOpportunityBody(quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", total: 12345.6 }), parties());
    expect(body.name).toBe("Q-US-2026-003 — USD 12,345.60");
    expect(body.stage).toMatchObject({ id: sentStage("US")!.id, process: { id: US_PROCESS } });
  });

  it("links the company when it has an ACT! id", () => {
    expect(newOpportunityBody(quote(), parties({ companyActId: COMPANY })).companies).toEqual([{ id: COMPANY }]);
  });

  it("leaves companies out when the company has no ACT! id, and is otherwise the same body", () => {
    const without = newOpportunityBody(quote(), parties());
    expect(without).not.toHaveProperty("companies");
    const withCompany = newOpportunityBody(quote(), parties({ companyActId: COMPANY }));
    expect({ ...without, companies: withCompany.companies }).toEqual(withCompany);
  });

  it("falls back to the service account when the author is not mapped", () => {
    expect(newOpportunityBody(quote(), parties({ authorActUserId: null })).recordManagerID).toBe(SERVICE);
  });

  it("refuses a region with no ACT! process rather than guessing one", () => {
    expect(() => newOpportunityBody(quote({ regionCode: "NZ" }), parties())).toThrow(/NZ/);
  });
});

describe("revisedOpportunityBody", () => {
  it("renames and re-totals, and moves the stage forward when it is behind", () => {
    const body = revisedOpportunityBody(quote({ total: 47500 }), { processId: SALES_CYCLE, number: 3 });
    expect(body.name).toBe("Q-AU-2026-014 — AUD 47,500.00");
    expect(body.productTotal).toBe(47500);
    expect(body.stage).toMatchObject({ id: sentStage("AU")!.id });
    expect(body.probability).toBe(40);
  });

  it("leaves the stage and probability alone when the deal is already further on", () => {
    const body = revisedOpportunityBody(quote(), { processId: SALES_CYCLE, number: 5 });
    expect(body).not.toHaveProperty("stage");
    expect(body).not.toHaveProperty("probability");
    expect(body.name).toBe("Q-AU-2026-014 — AUD 45,000.00");
  });

  it("leaves the stage alone when somebody moved the opportunity to another process", () => {
    const body = revisedOpportunityBody(quote(), { processId: US_PROCESS, number: 1 });
    expect(body).not.toHaveProperty("stage");
  });

  it("never touches the status, so a revision does not reopen a closed deal", () => {
    expect(revisedOpportunityBody(quote(), { processId: SALES_CYCLE, number: 3 })).not.toHaveProperty("status");
  });
});

describe("wonOpportunityBody", () => {
  it("closes the opportunity as won at the region's won stage", () => {
    const accepted = new Date("2026-11-02T01:00:00.000Z");
    const body = wonOpportunityBody("AU", { processId: SALES_CYCLE, number: 4 }, accepted);
    expect(body.status).toBe(OPPORTUNITY_STATUS.won);
    expect(body.stage).toMatchObject({ id: wonStage("AU")!.id });
    expect(body.probability).toBe(100);
    expect(body.actualCloseDate).toBe("2026-11-02T01:00:00.000Z");
  });

  it("still closes as won, without a stage, when the opportunity sits in another process", () => {
    const body = wonOpportunityBody("AU", { processId: US_PROCESS, number: 2 }, FINALISED);
    expect(body.status).toBe(OPPORTUNITY_STATUS.won);
    expect(body).not.toHaveProperty("stage");
  });
});

describe("lostOpportunityBody", () => {
  it("closes as lost with the reason, and leaves the stage where it is", () => {
    const body = lostOpportunityBody("Bought a second-hand cutter instead", FINALISED);
    expect(body.status).toBe(OPPORTUNITY_STATUS.lost);
    expect(body.reason).toBe("Bought a second-hand cutter instead");
    expect(body.actualCloseDate).toBe("2026-10-12T04:30:00.000Z");
    // A lost deal does not advance.
    expect(body).not.toHaveProperty("stage");
    expect(body).not.toHaveProperty("probability");
  });
});

describe("moneyWithCode", () => {
  it("renders two decimals with thousands separators", () => {
    expect(moneyWithCode(12345.6, "AUD")).toBe("AUD 12,345.60");
  });

  it("keeps the decimals on a whole amount", () => {
    expect(moneyWithCode(45000, "GBP")).toBe("GBP 45,000.00");
  });

  it("uses the code, never a symbol, for every currency", () => {
    // "$" is both AUD and USD; ACT! sums these with no currency of its own.
    expect(moneyWithCode(1000, "USD")).toBe("USD 1,000.00");
    expect(moneyWithCode(1000, "AUD")).not.toContain("$");
  });
});
