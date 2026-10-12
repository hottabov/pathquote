import { describe, it, expect } from "vitest";
import {
  CONTACT_STATUS,
  HISTORY_TYPE_QUOTE,
  OPPORTUNITY_STATUS,
  contactPromotion,
  historyBody,
  lostOpportunityBody,
  moneyWithCode,
  newContactBody,
  newOpportunityBody,
  opportunityIsOpen,
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
    expect(body.recordManagerID).toBe(AUTHOR);
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
  const open = (number: number, processId = SALES_CYCLE) => ({ processId, number, status: "Open" });

  /** The patch, failing the test if the opportunity was treated as closed. */
  function patchOf(update: RevisionUpdate) {
    if (update.kind !== "patch") throw new Error(`expected a patch, got ${update.kind}`);
    return update;
  }

  it("renames and re-totals an open deal, and moves the stage forward when it is behind", () => {
    const { patch, stage } = patchOf(revisedOpportunityBody(quote({ total: 47500 }), open(3)));
    expect(stage).toBe("move");
    expect(patch.name).toBe("Q-AU-2026-014 — AUD 47,500.00");
    // The new total reaches the amount through the product line, not here.
    expect(patch).not.toHaveProperty("productTotal");
    expect(patch).not.toHaveProperty("weightedTotal");
    expect(patch).not.toHaveProperty("grossMargin");
    expect(patch.stage).toMatchObject({ id: sentStage("AU")!.id });
    expect(patch.probability).toBe(40);
  });

  it("leaves the stage and probability alone when the deal is already further on", () => {
    const { patch, stage } = patchOf(revisedOpportunityBody(quote(), open(5)));
    expect(stage).toBe("stay");
    expect(patch).not.toHaveProperty("stage");
    expect(patch).not.toHaveProperty("probability");
    expect(patch.name).toBe("Q-AU-2026-014 — AUD 45,000.00");
  });

  it("leaves the stage alone when somebody moved the opportunity to another process, and says so", () => {
    const { patch, stage } = patchOf(revisedOpportunityBody(quote(), open(1, US_PROCESS)));
    expect(stage).toBe("different-process");
    expect(patch).not.toHaveProperty("stage");
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
  });

  it("still closes as won, without a stage, when the opportunity sits in another process, and says so", () => {
    const { patch, stage } = patchOf(wonOpportunityBody("AU", open(2, US_PROCESS), FINALISED));
    expect(stage).toBe("different-process");
    expect(patch.status).toBe(OPPORTUNITY_STATUS.won);
    expect(patch).not.toHaveProperty("stage");
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
  it("writes the line of an Open deal, accepted or not", () => {
    expect(productLineWrite("Open", false)).toEqual({ kind: "write" });
    expect(productLineWrite("Open", true)).toEqual({ kind: "write" });
  });

  it("writes the line of a Won deal once the quote is accepted: the accepted figure is what it was won at", () => {
    expect(productLineWrite("Won", true)).toEqual({ kind: "write" });
  });

  it("leaves the line of a deal Won by hand alone until PathQuote accepts the quote", () => {
    expect(productLineWrite("Won", false)).toEqual({ kind: "skip", status: "Won" });
  });

  it.each(["Lost", "Inactive", "open", "won", "", null])(
    "leaves the line of a %j deal alone, accepted or not, and says what ACT! said",
    (status) => {
      // A Lost deal of an accepted quote is overturned by win-opportunity,
      // which writes the line itself before the status.
      expect(productLineWrite(status, false)).toEqual({ kind: "skip", status });
      expect(productLineWrite(status, true)).toEqual({ kind: "skip", status });
    },
  );
});

describe("summaryProductBody and summaryProductPatch", () => {
  it("prices one line, quantity 1, at the revision's total, named with the revision and the currency", () => {
    expect(summaryProductPatch(quote({ revision: 2, total: 47500 }))).toEqual({
      name: "Q-AU-2026-014-R2 — AUD 47,500.00",
      quantity: 1,
      price: 47500,
      discountPrice: 47500,
      total: 47500,
    });
  });

  it("names the first revision by the bare quote number, as the History does", () => {
    expect(summaryProductPatch(quote({ revision: 0 })).name).toBe("Q-AU-2026-014 — AUD 45,000.00");
  });

  it("keeps the currency code in the name, the product having no currency field", () => {
    const line = summaryProductPatch(quote({ number: "Q-US-2026-003", regionCode: "US", currency: "USD", total: 12345.6 }));
    expect(line.name).toBe("Q-US-2026-003-R1 — USD 12,345.60");
    expect(line).not.toHaveProperty("currency");
  });

  it("creates the line with a zero discount, which a patch leaves out (swagger: ignored on updates)", () => {
    const q = quote({ total: 47500 });
    expect(summaryProductBody(q)).toEqual({ ...summaryProductPatch(q), discount: 0 });
    expect(summaryProductPatch(q)).not.toHaveProperty("discount");
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

  it("derives a company key from the name alone, since no country is sent", () => {
    // The sync keeps a contact it already has on its company and derives no
    // key for it; this is the key it WOULD derive, for the doc comment's one
    // case where it meets the contact without knowing it.
    const result = mapContact(asCreated(newContactBody(person(), owner())), () => null);
    if (result.kind !== "mapped") throw new Error(`expected mapped, got ${result.kind}`);
    expect(result.company.actCompanyKey).toBe(companyKey("Fielding Signs Pty Ltd", null));
    expect(result.company.actCompanyKey).toBe("fielding signs|??");
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
