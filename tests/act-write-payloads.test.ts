import { describe, it, expect } from "vitest";
import {
  CONTACT_STATUS,
  HISTORY_TYPE_QUOTE,
  OPPORTUNITY_STATUS,
  contactPromotion,
  historyBody,
  historyLookup,
  historyRegarding,
  lostOpportunityBody,
  OPPORTUNITY_NAME_MAX,
  moneyWithCode,
  newContactBody,
  newOpportunityBody,
  opportunityIsOpen,
  readOpportunityStatus,
  opportunityLookup,
  opportunityName,
  productLineLookup,
  productLineWrite,
  revisedOpportunityBody,
  summaryProductBody,
  summaryProductPatch,
  wonOpportunityBody,
  type QuoteForAct,
  type ActParties,
  type ContactForAct,
  type NewContactOwner,
  type RevisionUpdate,
  type WonUpdate,
} from "../src/lib/act/write-payloads";
import { sentStage, wonStage } from "../src/lib/act/opportunity-stages";
import { companyKey } from "../src/lib/act/company-key";
import { mapContact } from "../src/lib/act/map";
import { ACTIVE_STATUSES, type ActContact } from "../src/lib/act/types";
import { formatDocNumber } from "../src/lib/numbering";
import { REGIONS } from "../prisma/seed-lib";

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
  // A 10% GST quote: 45,000 before tax, 4,500 GST.
  amountExTax: 45000,
  total: 49500,
  taxName: "GST",
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
    expect(body.details).toContain("AUD 45,000.00 ex GST");
    expect(body.details).toContain("30 days");
    expect(body.details).toContain("Revision 1");
    expect(body.startTime).toBe("2026-10-12T04:30:00.000Z");
    expect(body.contacts).toEqual([{ id: CONTACT }]);
    expect(body.recordManagerID).toBe(AUTHOR);
  });

  it("leads with the amount before tax, the tax-inclusive total beside it for reference", () => {
    expect(historyBody(quote({ revision: 2 }), parties(), null).details).toBe(
      ["Amount: AUD 45,000.00 ex GST", "Total incl. GST: AUD 49,500.00", "Valid for 30 days", "Revision 2"].join("\n"),
    );
    expect(
      historyBody(quote({ currency: "GBP", amountExTax: 10000, total: 12000, taxName: "VAT" }), parties(), null).details.split("\n").slice(0, 2),
    ).toEqual(["Amount: GBP 10,000.00 ex VAT", "Total incl. VAT: GBP 12,000.00"]);
  });

  it("says no tax was charged on a quote with none, rather than a total 'incl.' a tax it does not carry", () => {
    // The US region's Sales Tax is 0%, and an export from AU keeps the name GST at 0%.
    const us = quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", amountExTax: 30000, total: 30000, taxName: "Sales Tax" });
    expect(historyBody(us, parties(), null).details.split("\n").slice(0, 2)).toEqual([
      "Amount: USD 30,000.00 ex Sales Tax",
      "Total: USD 30,000.00, no Sales Tax charged",
    ]);
    const exported = quote({ amountExTax: 45000, total: 45000 });
    expect(historyBody(exported, parties(), null).details).toContain("Total: AUD 45,000.00, no GST charged");
  });

  it("says 'tax' when the revision names none", () => {
    const details = historyBody(quote({ taxName: null }), parties(), null).details.split("\n");
    expect(details.slice(0, 2)).toEqual(["Amount: AUD 45,000.00 ex tax", "Total incl. tax: AUD 49,500.00"]);
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
  it("opens an opportunity at the region's sent stage, named with the quote number and its currency", () => {
    const body = newOpportunityBody(quote(), parties());
    expect(body.name).toBe("Q-AU-2026-014 AUD");
    // No amount in the name: it is the product line's, and 32 characters is too few.
    expect(body.name).not.toContain("45,000");
    expect(body.stage).toMatchObject({ id: sentStage("AU")!.id, process: { id: SALES_CYCLE } });
    expect(body.probability).toBe(sentStage("AU")!.probability);
    expect(body.status).toBe(OPPORTUNITY_STATUS.open);
    expect(body.openDate).toBe("2026-10-12T04:30:00.000Z");
    expect(body.contacts).toEqual([{ id: CONTACT }]);
    expect(body.recordManagerID).toBe(AUTHOR);
  });

  it("starts the stage when the opportunity opens: stageStartDate is the revision's finalizedAt, beside openDate", () => {
    const body = newOpportunityBody(quote(), parties());
    expect(body.stageStartDate).toBe("2026-10-12T04:30:00.000Z");
    expect(body.stageStartDate).toBe(body.openDate);
  });

  it("always sends estimatedCloseDate, which ACT! requires: the day the quote expires", () => {
    // Production refused a create without it, 2026-10-13:
    // "opportunity.EstimatedCloseDate": ["The EstimatedCloseDate field is required."]
    expect(newOpportunityBody(quote(), parties()).estimatedCloseDate).toBe("2026-11-11T04:30:00.000Z");
    expect(newOpportunityBody(quote({ validityDays: 1 }), parties()).estimatedCloseDate).toBe(
      "2026-10-13T04:30:00.000Z",
    );
  });

  it("sends no amount: ACT! computes the opportunity's totals from its products", () => {
    // productTotal, weightedTotal and grossMargin are isReadOnly and
    // isProtected in RAW/ACT/meta/fields_all.json. The amount is the summary
    // product line's (summaryProductBody).
    const body = newOpportunityBody(quote(), parties({ companyActId: COMPANY }));
    for (const computed of ["productTotal", "weightedTotal", "grossMargin"]) {
      expect(body).not.toHaveProperty(computed);
    }
  });

  it("puts a US quote on the US process with its own currency", () => {
    const body = newOpportunityBody(quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", total: 12345.6 }), parties());
    expect(body.name).toBe("Q-US-2026-003 USD");
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

  it("puts a region with no process of its own on the Pathfinder Sales Cycle", () => {
    expect(newOpportunityBody(quote({ regionCode: "IN", currency: "USD" }), parties()).stage).toMatchObject({
      id: sentStage("AU").id,
      process: { id: SALES_CYCLE },
    });
  });

  it("puts DCS on the US process", () => {
    expect(newOpportunityBody(quote({ regionCode: "DCS", currency: "USD" }), parties()).stage).toMatchObject({
      id: sentStage("US").id,
      process: { id: US_PROCESS },
    });
  });
});

describe("revisedOpportunityBody", () => {
  const open = (number: number, processId = SALES_CYCLE) => ({ processId, number, status: "Open" });

  /** The patch, failing the test if the opportunity was treated as closed. */
  function patchOf(update: RevisionUpdate) {
    if (update.kind !== "patch") throw new Error(`expected a patch, got ${update.kind}`);
    return update;
  }

  it("moves an open deal's stage forward when it is behind, starting the stage at the revision's finalise", () => {
    const finalised = new Date("2026-10-20T09:15:00.000Z");
    const { patch, stage } = patchOf(revisedOpportunityBody(quote({ total: 47500, finalizedAt: finalised }), open(3)));
    expect(stage).toBe("move");
    expect(patch).toEqual({
      stage: expect.objectContaining({ id: sentStage("AU")!.id }),
      probability: 40,
      stageStartDate: "2026-10-20T09:15:00.000Z",
    });
  });

  it("never renames the opportunity, and never sends an amount: the name is set on create, the total is the line's", () => {
    const { patch } = patchOf(revisedOpportunityBody(quote({ total: 47500 }), open(3)));
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("productTotal");
    expect(patch).not.toHaveProperty("weightedTotal");
    expect(patch).not.toHaveProperty("grossMargin");
  });

  it("sends nothing at all when the deal is already further on: no stage, no probability, no start date", () => {
    const { patch, stage } = patchOf(revisedOpportunityBody(quote({ total: 47500 }), open(5)));
    expect(stage).toBe("stay");
    expect(patch).toEqual({});
  });

  it("sends nothing when the deal is already at the sent stage: a repeat does not restart the stage", () => {
    expect(patchOf(revisedOpportunityBody(quote(), open(4))).patch).toEqual({});
  });

  it("leaves the stage alone when somebody moved the opportunity to another process, and says so", () => {
    const { patch, stage } = patchOf(revisedOpportunityBody(quote(), open(1, US_PROCESS)));
    expect(stage).toBe("different-process");
    expect(patch).toEqual({});
  });

  it("sends the same body every time for the same revision: the start date is the revision's, not the clock's", () => {
    expect(revisedOpportunityBody(quote(), open(3))).toEqual(revisedOpportunityBody(quote(), open(3)));
  });

  it("never sends a status to an open deal", () => {
    expect(patchOf(revisedOpportunityBody(quote(), open(3))).patch).not.toHaveProperty("status");
  });

  it.each(["Won", "Lost", "Inactive"])("leaves a %s opportunity entirely alone", (status) => {
    // Behind the sent stage on purpose: an open deal here would get a stage
    // move as well as a new name and total. A closed one gets nothing; the
    // revision is recorded by its History alone.
    expect(revisedOpportunityBody(quote({ total: 47500 }), { processId: SALES_CYCLE, number: 3, status })).toEqual({
      kind: "closed",
      status,
    });
  });

  it("treats a status it has never seen as not open", () => {
    // A misspelt Open costs updates to open deals; it never rewrites a closed one.
    expect(revisedOpportunityBody(quote(), { processId: SALES_CYCLE, number: 3, status: "open" }).kind).toBe("closed");
  });
});

describe("wonOpportunityBody", () => {
  const open = (number: number, processId = SALES_CYCLE) => ({ processId, number, status: "Open" });

  /** The patch, failing the test if the opportunity was not Open. */
  function patchOf(update: WonUpdate) {
    if (update.kind !== "patch") throw new Error(`expected a patch, got ${update.kind}`);
    return update;
  }

  it("closes an open opportunity as won at the region's won stage", () => {
    const accepted = new Date("2026-11-02T01:00:00.000Z");
    const { patch, stage, found } = patchOf(wonOpportunityBody("AU", open(4), accepted));
    expect(stage).toBe("move");
    expect(found).toBe("Open");
    expect(patch.status).toBe(OPPORTUNITY_STATUS.won);
    expect(patch.stage).toMatchObject({ id: wonStage("AU")!.id });
    expect(patch.probability).toBe(100);
    expect(patch.actualCloseDate).toBe("2026-11-02T01:00:00.000Z");
    // The won stage started when the quote was accepted.
    expect(patch.stageStartDate).toBe("2026-11-02T01:00:00.000Z");
  });

  it("sends no stage start date when the stage does not move", () => {
    // Already at the won stage, Open: the status changes, the stage does not.
    const { patch, stage } = patchOf(wonOpportunityBody("AU", open(7), FINALISED));
    expect(stage).toBe("stay");
    expect(patch).not.toHaveProperty("stageStartDate");
    expect(patch).not.toHaveProperty("stage");
  });

  it("still closes as won, without a stage, when the opportunity sits in another process, and says so", () => {
    const { patch, stage } = patchOf(wonOpportunityBody("AU", open(2, US_PROCESS), FINALISED));
    expect(stage).toBe("different-process");
    expect(patch.status).toBe(OPPORTUNITY_STATUS.won);
    expect(patch).not.toHaveProperty("stage");
    expect(patch).not.toHaveProperty("stageStartDate");
  });

  it("has nothing to do when the opportunity is already Won", () => {
    // Won by hand in ACT! first, or a resumed step whose patch went through
    // before its result was stored. Sending it again would only move the
    // close date to this acceptance.
    expect(wonOpportunityBody("AU", { processId: SALES_CYCLE, number: 6, status: "Won" }, FINALISED)).toEqual({
      kind: "already-won",
    });
  });

  it.each(["Lost", "Inactive"])("overturns a %s opportunity to Won, forward to the won stage, and says what it found", (status) => {
    // Vadym, 2026-10-12: "Overwrite to Won -- PathQuote confirms." The
    // acceptance is the confirmation, whichever closed status somebody set.
    const accepted = new Date("2026-11-02T01:00:00.000Z");
    const { patch, stage, found } = patchOf(
      wonOpportunityBody("AU", { processId: SALES_CYCLE, number: 4, status }, accepted),
    );
    expect(found).toBe(status);
    expect(stage).toBe("move");
    expect(patch).toEqual({
      status: OPPORTUNITY_STATUS.won,
      actualCloseDate: "2026-11-02T01:00:00.000Z",
      stage: expect.objectContaining({ id: wonStage("AU")!.id }),
      probability: 100,
      stageStartDate: "2026-11-02T01:00:00.000Z",
    });
    // A reason typed for the loss is somebody's note; the patch leaves it.
    expect(patch).not.toHaveProperty("reason");
  });

  it("overturns a Lost opportunity sitting in another process to Won, and leaves its stage there", () => {
    // Stage numbers do not compare across processes, so the forward-only rule
    // has nothing to move it by; the status is the acceptance's to decide.
    const { patch, stage } = patchOf(
      wonOpportunityBody("AU", { processId: US_PROCESS, number: 2, status: "Lost" }, FINALISED),
    );
    expect(stage).toBe("different-process");
    expect(patch.status).toBe(OPPORTUNITY_STATUS.won);
    expect(patch).not.toHaveProperty("stage");
    expect(patch).not.toHaveProperty("probability");
    expect(patch).not.toHaveProperty("stageStartDate");
  });

  it("treats a status it has never seen as not Won, and closes it as won", () => {
    // Only exactly Won is left alone. A misspelt Won costs at most a second
    // close date, once per deal: the planner never plans the win again.
    const update = wonOpportunityBody("AU", { processId: SALES_CYCLE, number: 4, status: "won" }, FINALISED);
    expect(update).toMatchObject({ kind: "patch", found: "won", patch: { status: OPPORTUNITY_STATUS.won } });
  });
});

describe("opportunityIsOpen", () => {
  it("is true for exactly Open, and false for every closed status, a different case, a stranger and none", () => {
    expect(opportunityIsOpen("Open")).toBe(true);
    for (const status of ["Won", "Lost", "Inactive", "open", " Open", "Pending", "", null]) {
      expect(opportunityIsOpen(status)).toBe(false);
    }
  });

  it("is the rule revisedOpportunityBody leaves a deal alone by", () => {
    for (const status of ["Open", "Won", "Lost", "Inactive", "open"]) {
      const kind = revisedOpportunityBody(quote(), { processId: SALES_CYCLE, number: 3, status }).kind;
      expect(kind === "patch").toBe(opportunityIsOpen(status));
    }
  });
});

describe("productLineWrite", () => {
  const ANY = [
    { accepted: false, signed: false },
    { accepted: false, signed: true },
    { accepted: true, signed: false },
    { accepted: true, signed: true },
  ];

  it("writes the line of an Open deal, whatever the quote's acceptance or signature", () => {
    for (const quote of ANY) expect(productLineWrite("Open", quote)).toEqual({ kind: "write" });
  });

  it("writes the line of a Won deal when the quote is accepted and the client's signature stands", () => {
    expect(productLineWrite("Won", { accepted: true, signed: true })).toEqual({ kind: "write" });
  });

  it("leaves a won deal's line alone for an accepted quote nobody has signed: acceptedAt outlives a voided signature", () => {
    expect(productLineWrite("Won", { accepted: true, signed: false })).toEqual({ kind: "skip", status: "Won" });
  });

  it("leaves the line of a deal Won by hand alone until PathQuote accepts the quote, signature or not", () => {
    expect(productLineWrite("Won", { accepted: false, signed: false })).toEqual({ kind: "skip", status: "Won" });
    expect(productLineWrite("Won", { accepted: false, signed: true })).toEqual({ kind: "skip", status: "Won" });
  });

  it.each(["Lost", "Inactive", "open", "won", "", null])(
    "leaves the line of a %j deal alone, accepted, signed or neither, and says what ACT! said",
    (status) => {
      // A Lost deal of an accepted quote is overturned by win-opportunity,
      // after write-accepted-line has written the line without asking this.
      for (const quote of ANY) expect(productLineWrite(status, quote)).toEqual({ kind: "skip", status });
    },
  );
});

describe("summaryProductBody and summaryProductPatch", () => {
  it("prices one line, quantity 1, at the revision's amount before tax, named with the revision, the currency and the tax", () => {
    expect(summaryProductPatch(quote({ revision: 2, amountExTax: 47500, total: 52250 }))).toEqual({
      name: "Q-AU-2026-014-R2 — AUD 47,500.00 ex GST",
      itemNumber: "Q-AU-2026-014",
      quantity: 1,
      price: 47500,
      discountPrice: 47500,
      total: 47500,
    });
  });

  it("never carries the tax-inclusive total, in a figure or in the name", () => {
    const line = summaryProductPatch(quote());
    expect([line.price, line.discountPrice, line.total]).toEqual([45000, 45000, 45000]);
    expect(line.name).not.toContain("49,500");
  });

  it("is the same figure as the total on a quote that charges no tax, still marked as before tax", () => {
    const line = summaryProductPatch(
      quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", amountExTax: 30000, total: 30000, taxName: "Sales Tax" }),
    );
    expect(line).toMatchObject({ name: "Q-US-2026-003-R1 — USD 30,000.00 ex Sales Tax", price: 30000, total: 30000 });
  });

  it("says 'ex tax' when the revision names no tax", () => {
    expect(summaryProductPatch(quote({ taxName: null })).name).toBe("Q-AU-2026-014-R1 — AUD 45,000.00 ex tax");
  });

  it("names the first revision by the bare quote number, as the History does", () => {
    expect(summaryProductPatch(quote({ revision: 0 })).name).toBe("Q-AU-2026-014 — AUD 45,000.00 ex GST");
  });

  it("keeps the currency code in the name, the product having no currency field", () => {
    const line = summaryProductPatch(
      quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", amountExTax: 12345.6, total: 12345.6, taxName: "Sales Tax" }),
    );
    expect(line.name).toBe("Q-US-2026-003-R1 — USD 12,345.60 ex Sales Tax");
    expect(line).not.toHaveProperty("currency");
  });

  it("creates the line with a zero discount, which a patch leaves out (swagger: ignored on updates)", () => {
    const q = quote({ amountExTax: 47500, total: 52250 });
    expect(summaryProductBody(q)).toEqual({ ...summaryProductPatch(q), discount: 0 });
    expect(summaryProductPatch(q)).not.toHaveProperty("discount");
  });

  it("carries the bare quote number as the item number on every revision, the key the line is found by", () => {
    for (const revision of [0, 1, 12]) {
      expect(summaryProductPatch(quote({ revision })).itemNumber).toBe("Q-AU-2026-014");
      expect(summaryProductBody(quote({ revision })).itemNumber).toBe("Q-AU-2026-014");
    }
  });

  it("is free-form: no catalogue product, no cost, no id of its own", () => {
    const body = summaryProductBody(quote());
    for (const field of ["productID", "cost", "id", "opportunityID", "type"]) {
      expect(body).not.toHaveProperty(field);
    }
  });
});

/** An ACT! contact as GET /api/contacts returns it, for the inbound mapper. */
function actContact(overrides: Partial<ActContact> = {}): ActContact {
  return {
    id: CONTACT,
    companyID: "",
    idStatus: "Prospect",
    contactType: "Contact",
    isPrivate: false,
    firstName: "Ross",
    lastName: "Fielding",
    jobTitle: null,
    emailAddress: null,
    businessPhone: null,
    mobilePhone: null,
    company: "Fielding Signs",
    website: null,
    businessAddress: null,
    recordManagerID: AUTHOR,
    recordManager: null,
    customFields: null,
    created: "2026-10-12T04:30:00.000Z",
    edited: "2026-10-12T04:30:00.000Z",
    ...overrides,
  };
}

/** What ACT! would hand back for a created body: the body's fields, on a record with an id. */
function asCreated(body: ReturnType<typeof newContactBody>): ActContact {
  return actContact({
    idStatus: body.idStatus,
    contactType: body.contactType,
    isPrivate: body.isPrivate,
    firstName: body.firstName ?? null,
    lastName: body.lastName ?? null,
    jobTitle: body.jobTitle ?? null,
    emailAddress: body.emailAddress ?? null,
    businessPhone: body.businessPhone ?? null,
    company: body.company ?? null,
    businessAddress: body.businessAddress
      ? { line1: null, line2: null, line3: null, city: null, state: null, postalCode: null, country: body.businessAddress.country }
      : null,
    recordManagerID: body.recordManagerID,
    customFields: body.customFields ?? null,
  });
}

describe("newContactBody", () => {
  const person = (overrides: Partial<ContactForAct> = {}): ContactForAct => ({
    firstName: "Ross",
    lastName: "Fielding",
    email: "ross@fieldingsigns.example",
    phone: "+61394679176",
    position: "Operations Manager",
    companyName: "Fielding Signs Pty Ltd",
    country: null,
    ...overrides,
  });
  const owner = (overrides: Partial<NewContactOwner> = {}): NewContactOwner => ({
    authorActUserId: AUTHOR,
    authorActAccountMgr: "Jane Citizen",
    serviceAccountUserId: SERVICE,
    ...overrides,
  });

  it("creates a Prospect, never a blank status the sync would skip and promotion would ignore", () => {
    const body = newContactBody(person(), owner());
    expect(body.idStatus).toBe(CONTACT_STATUS.prospect);
    expect(body.idStatus).toBe("Prospect");
    expect(ACTIVE_STATUSES).toContain(body.idStatus);
    // And the step that follows a signature would promote it.
    expect(contactPromotion(body.idStatus).kind).toBe("promote");
  });

  it("names every field the way the ACT! API spells it", () => {
    expect(newContactBody(person(), owner())).toEqual({
      firstName: "Ross",
      lastName: "Fielding",
      emailAddress: "ross@fieldingsigns.example",
      businessPhone: "+61394679176",
      jobTitle: "Operations Manager",
      company: "Fielding Signs Pty Ltd",
      idStatus: "Prospect",
      contactType: "Contact",
      isPrivate: false,
      recordManagerID: AUTHOR,
      customFields: { rep: "Jane Citizen" },
    });
  });

  it("sets Account Mgr from the author's mapped picklist item", () => {
    expect(newContactBody(person(), owner()).customFields).toEqual({ rep: "Jane Citizen" });
  });

  it("leaves Account Mgr out altogether when the author has none, rather than guess a picklist value", () => {
    const body = newContactBody(person(), owner({ authorActAccountMgr: null }));
    expect(body).not.toHaveProperty("customFields");
    expect(JSON.stringify(body)).not.toContain("rep");
  });

  it("carries the company name as the contact's free-text company", () => {
    expect(newContactBody(person({ companyName: "  Norco Composites & GRP  " }), owner()).company).toBe(
      "Norco Composites & GRP",
    );
  });

  it("is still a valid body for a contact with no email, phone, title or surname", () => {
    const body = newContactBody(
      person({ lastName: null, email: null, phone: "  ", position: null }),
      owner({ authorActUserId: null, authorActAccountMgr: null }),
    );
    expect(body).toEqual({
      firstName: "Ross",
      company: "Fielding Signs Pty Ltd",
      idStatus: "Prospect",
      contactType: "Contact",
      isPrivate: false,
      recordManagerID: SERVICE,
    });
  });

  it("comes back through the inbound mapper as the same person, still a Prospect", () => {
    const result = mapContact(asCreated(newContactBody(person({ email: "Ross@FieldingSigns.example" }), owner())), () => null);
    if (result.kind !== "mapped") throw new Error(`expected mapped, got ${result.kind}`);
    expect(result.contact).toMatchObject({
      firstName: "Ross",
      lastName: "Fielding",
      email: "ross@fieldingsigns.example",
      phone: "+61394679176",
      position: "Operations Manager",
      actAccountMgr: "Jane Citizen",
    });
    expect(result.company.actStatus).toBe("Prospect");
    expect(result.company.name).toBe("Fielding Signs Pty Ltd");
  });

  it("derives a company key from the name alone when no country is sent", () => {
    // The sync keeps a contact it already has on its company and derives no
    // key for it; this is the key it WOULD derive, for the doc comment's one
    // case where it meets the contact without knowing it.
    const result = mapContact(asCreated(newContactBody(person(), owner())), () => null);
    if (result.kind !== "mapped") throw new Error(`expected mapped, got ${result.kind}`);
    expect(result.company.actCompanyKey).toBe(companyKey("Fielding Signs Pty Ltd", null));
    expect(result.company.actCompanyKey).toBe("fielding signs|??");
  });

  it("sends the company's country as the business address's country, and nothing else of the address", () => {
    const body = newContactBody(person({ country: "Australia" }), owner());
    expect(body.businessAddress).toEqual({ country: "Australia" });
  });

  it("sends the picklist's spelling exactly as it was handed in, and leaves a blank one out", () => {
    expect(newContactBody(person({ country: "United States " }), owner()).businessAddress).toEqual({
      country: "United States ",
    });
    expect(newContactBody(person({ country: "  " }), owner())).not.toHaveProperty("businessAddress");
    expect(newContactBody(person({ country: null }), owner())).not.toHaveProperty("businessAddress");
  });

  it("comes back through the inbound mapper in the same country, keyed by it", () => {
    const result = mapContact(asCreated(newContactBody(person({ country: "Australia" }), owner())), () => null);
    if (result.kind !== "mapped") throw new Error(`expected mapped, got ${result.kind}`);
    expect(result.company.country).toBe("AU");
    expect(result.company.actCompanyKey).toBe(companyKey("Fielding Signs Pty Ltd", "AU"));
  });
});

describe("contactPromotion", () => {
  it("promotes a Prospect to Customer, and the patch sets idStatus and nothing else", () => {
    expect(contactPromotion("Prospect")).toEqual({ kind: "promote", patch: { idStatus: "Customer" } });
  });

  it("leaves a contact that is already a Customer alone, and counts that as done", () => {
    expect(contactPromotion("Customer")).toEqual({ kind: "leave", reason: "already-customer", current: "Customer" });
  });

  it.each(["Prospect-Distributor", "Supplier", "Personal", "Suspect"])(
    "leaves a %s alone: a status somebody set deliberately is not ours to change",
    (status) => {
      expect(contactPromotion(status)).toEqual({ kind: "leave", reason: "not-prospect", current: status });
    },
  );

  it.each([null, "", "   "])("leaves a blank status (%j) alone", (status) => {
    expect(contactPromotion(status)).toEqual({ kind: "leave", reason: "not-prospect", current: status });
  });

  it("reads a Prospect the way the inbound sync does: trimmed, so stray spaces still promote", () => {
    // mapContact trims idStatus, so " Prospect" is imported as a Prospect; a
    // stricter comparison here would never promote it. The patch writes the
    // exact constant.
    expect(contactPromotion(" Prospect ")).toEqual({ kind: "promote", patch: { idStatus: "Customer" } });
    const imported = mapContact(actContact({ idStatus: " Prospect " }), () => null);
    expect(imported.kind).toBe("mapped");
  });

  it("trims a Customer the same way, and reports the status as ACT! has it", () => {
    expect(contactPromotion("Customer ")).toEqual({ kind: "leave", reason: "already-customer", current: "Customer " });
  });

  it("still matches case for case, as the inbound sync does, so another spelling is left alone", () => {
    expect(contactPromotion("prospect").kind).toBe("leave");
    expect(contactPromotion("PROSPECT").kind).toBe("leave");
  });

  it("only ever writes statuses the inbound sync imports", () => {
    // A promoted contact must stay in PathQuote on the next sync. Both values
    // come from the "Contact ID/Status" picklist, and ACTIVE_STATUSES is the
    // inbound filter; if either moves without the other, this fails.
    expect(ACTIVE_STATUSES).toContain(CONTACT_STATUS.prospect);
    expect(ACTIVE_STATUSES).toContain(CONTACT_STATUS.customer);
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

describe("what fits in ACT!'s fields", () => {
  // The longest realistic quote number: a five-digit counter (formatDocNumber
  // pads to three and never truncates), a four-digit year, and every region
  // in the seed, each with its own currency.
  const longest = REGIONS.map((region) => ({
    number: formatDocNumber(region.code, 2099, 99999),
    currency: region.currency,
    regionCode: region.code,
    taxName: region.taxName,
  }));

  it("names every opportunity within its 32 characters, a five-digit counter in any region included", () => {
    expect(OPPORTUNITY_NAME_MAX).toBe(32);
    expect(longest.length).toBeGreaterThanOrEqual(3);
    for (const q of longest) {
      const name = opportunityName(q);
      expect(name).toBe(`${q.number} ${q.currency}`);
      expect(name.length).toBeLessThanOrEqual(OPPORTUNITY_NAME_MAX);
    }
    expect(opportunityName({ number: "Q-AU-2099-99999", currency: "AUD" })).toBe("Q-AU-2099-99999 AUD");
  });

  it("names the product line within its 256 characters at the largest amount a quote can hold", () => {
    // QuoteRevision.total is Decimal(12,2): at most 9,999,999,999.99, and the
    // amount before tax is no more than that.
    for (const q of longest) {
      const line = summaryProductPatch(quote({ ...q, revision: 99, amountExTax: 9_999_999_999.99, total: 9_999_999_999.99 }));
      expect(line.name).toBe(`${q.number}-R99 — ${q.currency} 9,999,999,999.99 ex ${q.taxName}`);
      expect(line.name.length).toBeLessThanOrEqual(256);
      // "Item #" is Character 64.
      expect(line.itemNumber.length).toBeLessThanOrEqual(64);
    }
    // A Custom tax's own name is at most 40 characters (taxNameSchema).
    const custom = summaryProductPatch(quote({ ...longest[0], revision: 99, amountExTax: 9_999_999_999.99, taxName: "T".repeat(40) }));
    expect(custom.name.length).toBeLessThanOrEqual(256);
  });

  it("leaves the opportunity's name as number and currency code, whatever the amount and the tax", () => {
    const q = quote({ ...longest[0], amountExTax: 9_999_999_999.99, total: 9_999_999_999.99 });
    const body = newOpportunityBody(q, parties());
    expect(body.name).toBe(`${q.number} ${q.currency}`);
    expect(body.name.length).toBeLessThanOrEqual(OPPORTUNITY_NAME_MAX);
    expect(body.name).not.toMatch(/ex |GST|\d,\d/);
  });
});

describe("productLineLookup", () => {
  const LINE = "c0000000-0000-0000-0000-0000000000d0";
  const OTHER = "c0000000-0000-0000-0000-0000000000d1";

  it("creates when the opportunity has no line with this quote's number", () => {
    expect(productLineLookup([], quote())).toEqual({ kind: "create" });
    // Lines somebody added by hand, with another item number or none, are not ours.
    expect(
      productLineLookup([{ id: OTHER, itemNumber: "PF-1000" }, { id: LINE, itemNumber: null }, { id: LINE }], quote()),
    ).toEqual({ kind: "create" });
  });

  it("adopts the one line with this quote's number: the create that went through and was never stored", () => {
    const lines = [
      { id: OTHER, itemNumber: "PF-1000" },
      { id: LINE, itemNumber: "Q-AU-2026-014" },
    ];
    expect(productLineLookup(lines, quote())).toEqual({ kind: "adopt", id: LINE });
  });

  it("matches the number exactly: another quote's number, a prefix, another case or stray spaces is not this line", () => {
    for (const itemNumber of ["Q-AU-2026-0140", "Q-AU-2026-01", "q-au-2026-014", " Q-AU-2026-014", "Q-AU-2026-014-R1"]) {
      expect(productLineLookup([{ id: LINE, itemNumber }], quote())).toEqual({ kind: "create" });
    }
  });

  it("blocks on two lines with this quote's number, rather than pick one or add a third", () => {
    const lines = [
      { id: LINE, itemNumber: "Q-AU-2026-014" },
      { id: OTHER, itemNumber: "Q-AU-2026-014" },
    ];
    expect(productLineLookup(lines, quote())).toEqual({ kind: "block", count: 2 });
  });

  it("blocks on a match it cannot adopt for want of an id", () => {
    expect(productLineLookup([{ itemNumber: "Q-AU-2026-014" }], quote())).toEqual({ kind: "block", count: 1 });
  });
});

describe("opportunityLookup", () => {
  const OTHER = "c0000000-0000-0000-0000-0000000000a1";

  it("creates when none of the opportunities ACT! returned has this deal's name", () => {
    expect(opportunityLookup([], quote())).toEqual({ kind: "create" });
    expect(
      opportunityLookup([{ id: OTHER, name: "Q-AU-2026-013 AUD" }, { id: OTHER, name: "Cutter upgrade" }], quote()),
    ).toEqual({ kind: "create" });
  });

  it("adopts the one opportunity with exactly this deal's name, whatever its status", () => {
    const opportunities = [
      { id: OTHER, name: "Q-AU-2026-013 AUD", status: "Open" },
      { id: OPPORTUNITY, name: "Q-AU-2026-014 AUD", status: "Lost" },
    ];
    expect(opportunityLookup(opportunities, quote())).toEqual({ kind: "adopt", id: OPPORTUNITY });
  });

  it("does not take an opportunity in another currency, or under the old name with an amount, for this one", () => {
    expect(opportunityLookup([{ id: OTHER, name: "Q-AU-2026-014 USD" }], quote())).toEqual({ kind: "create" });
    expect(opportunityLookup([{ id: OTHER, name: "Q-AU-2026-014 — AUD 45,000.00" }], quote())).toEqual({
      kind: "create",
    });
  });

  it("blocks on two opportunities with this deal's name", () => {
    const opportunities = [
      { id: OPPORTUNITY, name: "Q-AU-2026-014 AUD" },
      { id: OTHER, name: "Q-AU-2026-014 AUD" },
    ];
    expect(opportunityLookup(opportunities, quote())).toEqual({ kind: "block", count: 2 });
  });
});

describe("historyRegarding and historyLookup", () => {
  const HISTORY = "c0000000-0000-0000-0000-0000000000b0";
  const OLDER = "c0000000-0000-0000-0000-0000000000b1";
  const NEWER = "c0000000-0000-0000-0000-0000000000b2";
  const r2 = { number: "Q-AU-2026-014", revision: 2 };
  const ours = (id: unknown, created?: unknown) => ({
    id,
    historyTypeID: HISTORY_TYPE_QUOTE,
    regarding: "Quote Q-AU-2026-014-R2 finalised in PathQuote",
    ...(created === undefined ? {} : { created }),
  });

  it("is the History's own regarding, one sentence per revision", () => {
    expect(historyRegarding(r2)).toBe("Quote Q-AU-2026-014-R2 finalised in PathQuote");
    expect(historyRegarding({ ...r2, revision: 0 })).toBe("Quote Q-AU-2026-014 finalised in PathQuote");
    expect(historyBody(quote({ revision: 2 }), parties(), null).regarding).toBe(historyRegarding(r2));
  });

  it("creates when none of the contact's Histories is this revision's", () => {
    expect(historyLookup([], r2)).toEqual({ kind: "create" });
    const others = [
      // Another revision of the same quote, another quote, a note somebody typed.
      { ...ours(HISTORY), regarding: "Quote Q-AU-2026-014-R1 finalised in PathQuote" },
      { ...ours(HISTORY), regarding: "Quote Q-AU-2026-0140-R2 finalised in PathQuote" },
      { id: HISTORY, historyTypeID: 1, regarding: "Called about the cutter" },
    ];
    expect(historyLookup(others, r2)).toEqual({ kind: "create" });
  });

  it("matches the type and the regarding exactly", () => {
    // The same words under another history type are not PathQuote's Quote entry.
    expect(historyLookup([{ ...ours(HISTORY), historyTypeID: 1 }], r2)).toEqual({ kind: "create" });
    expect(historyLookup([{ ...ours(HISTORY), historyTypeID: "62" }], r2)).toEqual({ kind: "create" });
    for (const regarding of [
      "quote Q-AU-2026-014-R2 finalised in PathQuote",
      "Quote Q-AU-2026-014-R2 finalised in PathQuote ",
      "Quote Q-AU-2026-014-R2 finalised in PathQuote.",
    ]) {
      expect(historyLookup([{ ...ours(HISTORY), regarding }], r2)).toEqual({ kind: "create" });
    }
  });

  it("adopts the one History that is this revision's", () => {
    expect(historyLookup([ours(HISTORY, "2026-10-12T04:30:05Z")], r2)).toEqual({ kind: "adopt", id: HISTORY, matches: 1 });
  });

  it("does not block on more than one: it adopts the oldest and says how many there were", () => {
    const histories = [
      ours(NEWER, "2026-10-13T00:00:00Z"),
      ours(OLDER, "2026-10-12T04:30:05Z"),
      ours(HISTORY, "2026-10-12T09:00:00Z"),
    ];
    expect(historyLookup(histories, r2)).toEqual({ kind: "adopt", id: OLDER, matches: 3 });
    // The same answer in any order gives the same choice.
    expect(historyLookup([...histories].reverse(), r2)).toEqual({ kind: "adopt", id: OLDER, matches: 3 });
  });

  it("puts a match with no readable `created` after the dated ones, and breaks a tie by id", () => {
    expect(historyLookup([ours(OLDER), ours(NEWER, "2026-10-13T00:00:00Z")], r2)).toEqual({
      kind: "adopt",
      id: NEWER,
      matches: 2,
    });
    expect(historyLookup([ours(NEWER, "not a date"), ours(OLDER)], r2)).toEqual({ kind: "adopt", id: OLDER, matches: 2 });
    const same = "2026-10-12T04:30:05Z";
    expect(historyLookup([ours(NEWER, same), ours(OLDER, same)], r2)).toEqual({ kind: "adopt", id: OLDER, matches: 2 });
  });

  it("passes over a match it could not store for want of an id, and creates when that is all there is", () => {
    expect(historyLookup([ours(undefined), ours(""), ours(HISTORY, "2026-10-13T00:00:00Z")], r2)).toEqual({
      kind: "adopt",
      id: HISTORY,
      matches: 3,
    });
    expect(historyLookup([ours(undefined), ours(42)], r2)).toEqual({ kind: "create" });
  });
});

describe("readOpportunityStatus", () => {
  it("names the numbers ACT! reads back, in swagger's order", () => {
    expect([0, 1, 2, 3].map(readOpportunityStatus)).toEqual(["Open", "Won", "Lost", "Inactive"]);
  });

  it("keeps a string as it came, and makes nothing Open that is not", () => {
    expect(readOpportunityStatus("Open")).toBe("Open");
    expect(readOpportunityStatus(7)).toBe("7");
    expect(readOpportunityStatus(0.5)).toBe("");
    expect(readOpportunityStatus(null)).toBe("");
    expect(opportunityIsOpen(readOpportunityStatus(7))).toBe(false);
  });

  it("lets the first revision's line be written on a deal ACT! reads back as 0", () => {
    expect(productLineWrite(readOpportunityStatus(0), { accepted: false, signed: false })).toEqual({ kind: "write" });
  });
});
