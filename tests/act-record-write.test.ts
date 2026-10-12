import { describe, it, expect } from "vitest";
import {
  NEVER_CONNECTED_CODES,
  OPPORTUNITY_COMPUTED_FIELDS,
  classifyWriteFailure,
  failureOf,
  isRetried,
  mergeForWrite,
  neverConnected,
  odataString,
  patchToSend,
  sameRecordId,
  sameValue,
  writableOpportunity,
  writeAnswer,
} from "../src/lib/act/record-write";
import {
  lostOpportunityBody,
  revisedOpportunityBody,
  summaryProductPatch,
  wonOpportunityBody,
} from "../src/lib/act/write-payloads";

const ID = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** A contact as GET /api/contacts/{id} might return it: nested objects and a bag of custom fields. */
function contact(): Record<string, unknown> {
  return {
    id: ID,
    firstName: "Ann",
    lastName: "Lee",
    idStatus: "Prospect",
    edited: "2026-10-01T00:00:00Z",
    businessAddress: {
      line1: "1 Main St",
      city: "Perth",
      state: "WA",
      postalCode: "6000",
      country: "Australia",
      latitude: -31.95,
      longitude: 115.86,
    },
    customFields: { rep: "John Hollo", user6: "Signage", serial_1: "PF-123", priority: "A" },
  };
}

describe("isRetried", () => {
  it("never repeats a POST: a create that timed out may already exist in ACT!", () => {
    expect(isRetried("POST")).toBe(false);
  });

  it("repeats a GET, and a PATCH, which always carries the whole record", () => {
    expect(isRetried("GET")).toBe(true);
    expect(isRetried("PATCH")).toBe(true);
  });
});

describe("classifyWriteFailure", () => {
  it("is no failure for any 2xx, whatever the method", () => {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      for (const status of [200, 201, 204, 299]) expect(classifyWriteFailure(method, status)).toBeNull();
    }
  });

  it("calls a create untracked when no answer came, when it was answered 5xx, and when a 2xx did not give the record", () => {
    // Each may mean ACT! made the record; creating it again would make a second.
    expect(classifyWriteFailure("POST", "no-answer")).toBe("untracked");
    expect(classifyWriteFailure("POST", 500)).toBe("untracked");
    expect(classifyWriteFailure("POST", 503)).toBe("untracked");
    expect(classifyWriteFailure("POST", "unreadable")).toBe("untracked");
  });

  it("calls a create answered 4xx refused: ACT! turned it away and made nothing", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) expect(classifyWriteFailure("POST", status)).toBe("refused");
  });

  it("calls a read or a whole-record PATCH that got no answer, a 5xx or an unreadable one failed: safe to repeat", () => {
    for (const method of ["GET", "PATCH"] as const) {
      expect(classifyWriteFailure(method, "no-answer")).toBe("failed");
      expect(classifyWriteFailure(method, 500)).toBe("failed");
      expect(classifyWriteFailure(method, 502)).toBe("failed");
      expect(classifyWriteFailure(method, "unreadable")).toBe("failed");
    }
  });

  it("calls any 4xx refused for a read or a PATCH too, and a 1xx with it", () => {
    for (const method of ["GET", "PATCH", "POST"] as const) {
      for (const status of [100, 400, 404, 499]) expect(classifyWriteFailure(method, status)).toBe("refused");
    }
  });

  it("calls a create answered with a redirect untracked: unfollowed, a 303 is how a server points at what it made", () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) expect(classifyWriteFailure("POST", status)).toBe("untracked");
  });

  it("calls a read or a PATCH answered with a redirect refused: repeating it gets the same redirect, a setup error", () => {
    for (const method of ["GET", "PATCH"] as const) {
      for (const status of [301, 302, 303, 304, 307, 308]) expect(classifyWriteFailure(method, status)).toBe("refused");
    }
  });

  it("calls a request that never connected failed, a create included: nothing reached ACT!, so trying again is safe", () => {
    for (const method of ["GET", "POST", "PATCH"] as const) expect(classifyWriteFailure(method, "not-sent")).toBe("failed");
  });

  it("agrees with isRetried: the methods repeated after a lost answer are the ones whose lost answer is not untracked", () => {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      expect(isRetried(method)).toBe(classifyWriteFailure(method, "no-answer") !== "untracked");
      expect(isRetried(method)).toBe(classifyWriteFailure(method, 503) !== "untracked");
    }
  });
});

/** What Node's fetch rejects with: a TypeError whose cause carries the code. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError("fetch failed", { cause });
}

function systemError(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe("neverConnected", () => {
  it("is the exact list the review asked for, and the two Node codes that mean the same", () => {
    expect([...NEVER_CONNECTED_CODES].sort()).toEqual(
      [
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EHOSTUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "ENETUNREACH",
        "ERR_SOCKET_CONNECTION_TIMEOUT",
      ].sort(),
    );
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_SOCKET_CONNECTION_TIMEOUT"])(
    "reads %s off fetch's cause: no connection, so nothing was sent",
    (code) => {
      expect(neverConnected(fetchFailed(systemError(code)))).toBe(code);
    },
  );

  it("reads undici's ConnectTimeoutError, whose code is its own", () => {
    const timeout = Object.assign(new Error("Connect Timeout Error (attempted address: 10.0.0.1:443, timeout: 10000ms)"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(neverConnected(fetchFailed(timeout))).toBe("UND_ERR_CONNECT_TIMEOUT");
  });

  it("reads the code Node puts on the AggregateError of a name with several addresses, all refused", () => {
    const refused = [systemError("ECONNREFUSED"), systemError("ECONNREFUSED")];
    const aggregate = Object.assign(new AggregateError(refused), { code: "ECONNREFUSED" });
    expect(neverConnected(fetchFailed(aggregate))).toBe("ECONNREFUSED");
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "EPIPE"])(
    "is null for %s, which can come after the request was written",
    (code) => {
      expect(neverConnected(fetchFailed(systemError(code)))).toBeNull();
    },
  );

  it("is null for the request's own timeout, which carries no code", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(neverConnected(timeout)).toBeNull();
    expect(neverConnected(fetchFailed(undefined))).toBeNull();
  });

  it("reads only fetch's cause, not a code on the error itself, and nothing from a non-error", () => {
    expect(neverConnected(systemError("ECONNREFUSED"))).toBeNull();
    expect(neverConnected("ECONNREFUSED")).toBeNull();
    expect(neverConnected(null)).toBeNull();
    expect(neverConnected(fetchFailed({ code: 111 }))).toBeNull();
  });
});

describe("failureOf", () => {
  it("is classifyWriteFailure for every answer that is a failure", () => {
    for (const method of ["GET", "POST", "PATCH"] as const) {
      for (const answer of ["not-sent", "no-answer", "unreadable", 100, 301, 404, 500] as const) {
        expect(failureOf(method, answer)).toBe(classifyWriteFailure(method, answer));
      }
    }
  });

  it("refuses to classify a 2xx: an error built on one would say it was no failure", () => {
    expect(() => failureOf("GET", 200)).toThrow(/not a failure/);
    expect(() => failureOf("POST", 201)).toThrow(/not a failure/);
  });
});

describe("sameRecordId", () => {
  it("compares uuids ignoring case, and nothing else", () => {
    expect(sameRecordId(ID, ID.toUpperCase())).toBe(true);
    expect(sameRecordId(ID, "11111111-2222-4333-8444-555555555555")).toBe(false);
    expect(sameRecordId(ID, ` ${ID}`)).toBe(false);
  });
});

describe("mergeForWrite", () => {
  it("overrides top-level fields and keeps every other field of the record", () => {
    const merged = mergeForWrite(ID, contact(), { idStatus: "Customer" });
    expect(merged).toEqual({ ...contact(), idStatus: "Customer" });
  });

  it("merges customFields key by key, so the custom fields the patch does not name survive", () => {
    const merged = mergeForWrite(ID, contact(), { customFields: { rep: "Jane Roe" } });
    expect(merged.customFields).toEqual({
      rep: "Jane Roe",
      user6: "Signage",
      serial_1: "PF-123",
      priority: "A",
    });
  });

  it("adds a custom field the record does not carry yet, and copes with a record whose customFields is null", () => {
    expect(mergeForWrite(ID, contact(), { customFields: { owner: "Vadym" } }).customFields).toEqual({
      ...(contact().customFields as object),
      owner: "Vadym",
    });
    const bare = { ...contact(), customFields: null };
    expect(mergeForWrite(ID, bare, { customFields: { rep: "Jane Roe" } }).customFields).toEqual({
      rep: "Jane Roe",
    });
  });

  it("clears one custom field with null and leaves an undefined one alone", () => {
    const merged = mergeForWrite(ID, contact(), {
      customFields: { serial_1: null, user6: undefined },
    });
    expect(merged.customFields).toEqual({
      rep: "John Hollo",
      user6: "Signage",
      serial_1: null,
      priority: "A",
    });
  });

  it("refuses a customFields that is null or not an object, rather than blanking every custom field", () => {
    expect(() => mergeForWrite(ID, contact(), { customFields: null })).toThrow(/customFields/);
    expect(() => mergeForWrite(ID, contact(), { customFields: "rep" })).toThrow(/customFields/);
    expect(() => mergeForWrite(ID, contact(), { customFields: ["rep"] })).toThrow(/customFields/);
  });

  it("does not touch the record it was given", () => {
    const current = contact();
    mergeForWrite(ID, current, { idStatus: "Customer", customFields: { rep: "Jane Roe" } });
    expect(current).toEqual(contact());
  });

  it("always puts the id in the body, even when the record read back has none", () => {
    const { id: _dropped, ...withoutId } = contact();
    void _dropped;
    expect(mergeForWrite(ID, withoutId, { idStatus: "Customer" }).id).toBe(ID);
    expect(mergeForWrite(ID, contact(), {}).id).toBe(ID);
  });

  it("will not let an id in the patch move the write to another record", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(mergeForWrite(ID, contact(), { id: other }).id).toBe(ID);
  });

  it("refuses a record read back with a different id, and accepts one that differs only in case", () => {
    const other = { ...contact(), id: "11111111-2222-4333-8444-555555555555" };
    expect(() => mergeForWrite(ID, other, {})).toThrow(/carries id/);
    const shouted = { ...contact(), id: ID.toUpperCase() };
    expect(mergeForWrite(ID, shouted, {}).id).toBe(ID);
  });

  it("clears a top-level field with null, and keeps it for undefined", () => {
    const opportunity = { id: ID, status: "Lost", reason: "Price" };
    expect(mergeForWrite(ID, opportunity, { reason: null }).reason).toBeNull();
    expect(mergeForWrite(ID, opportunity, { reason: undefined }).reason).toBe("Price");
  });

  it("replaces a nested object in the patch whole: a new stage does not inherit the old one's fields", () => {
    const opportunity = {
      id: ID,
      status: "Open",
      stage: {
        id: "old-stage",
        name: "Quoted",
        description: "Quote sent to the client",
        probability: 50,
        number: 3,
        process: { id: "p1", name: "Pathfinder Sales Cycle" },
      },
    };
    const stage = { id: "new-stage", name: "Won", probability: 100, number: 7, process: { id: "p1" } };
    expect(mergeForWrite(ID, opportunity, { stage }).stage).toEqual(stage);
  });

  it("keeps a nested object the patch does not name exactly as read -- the address is not rebuilt", () => {
    const merged = mergeForWrite(ID, contact(), { idStatus: "Customer" });
    expect(merged.businessAddress).toEqual(contact().businessAddress);
  });

  it("lays the payload builders' real patches over an opportunity without losing the loss reason", () => {
    const lost = {
      id: ID,
      name: "Q-AU-2026-014 AUD",
      status: "Lost",
      reason: "Went with a competitor",
      stage: { id: "s3", number: 3, process: { id: "2380e83d-cef4-4b6d-ad15-dc9a558431ab" } },
      productTotal: 45000,
      weightedTotal: 22500,
    };
    const won = wonOpportunityBody("AU", { processId: "2380e83d-cef4-4b6d-ad15-dc9a558431ab", number: 3, status: "Lost" }, new Date("2026-10-12T00:00:00Z"));
    if (won.kind !== "patch") throw new Error("expected a patch");
    const merged = mergeForWrite(ID, lost, won.patch);
    expect(merged.status).toBe("Won");
    expect(merged.reason).toBe("Went with a competitor");
    expect(merged.weightedTotal).toBe(22500);
    expect(merged.actualCloseDate).toBe("2026-10-12T00:00:00.000Z");

    const relost = mergeForWrite(ID, merged, lostOpportunityBody("Cancelled", new Date("2026-10-13T00:00:00Z")));
    expect(relost.reason).toBe("Cancelled");
    expect(relost.stage).toEqual(merged.stage);
  });
});

/** An opportunity as GET /api/opportunities/{id} might return it, computed fields and all. */
function opportunity(): Record<string, unknown> {
  return {
    id: ID,
    name: "Q-AU-2026-014 AUD",
    status: "Open",
    stage: { id: "s3", name: "Quoted", number: 3, probability: 50, process: { id: "p1" } },
    probability: 50,
    productTotal: 45000,
    weightedTotal: 22500,
    grossMargin: 45000,
    daysOpen: 12,
    daysInStage: 4,
    contactNames: "Ross Fielding",
    totalPerContact: 45000,
    totalPerCompany: 45000,
    totalPerGroup: 0,
    creator: "John Hollo",
    manager: "John Hollo",
    recordManager: "John Hollo",
    recordManagerID: "a0000000-0000-0000-0000-000000000001",
    reason: null,
    importDate: "2026-10-01T00:00:00Z",
    customFields: { opportunity_field_1: "x" },
    created: "2026-10-01T00:00:00Z",
    edited: "2026-10-12T00:00:00Z",
    editedBy: "John Hollo",
  };
}

describe("writableOpportunity", () => {
  it("drops every field ACT! computes or sets: the three fields_all.json protects, the eight it derives on read, and importDate", () => {
    expect([...OPPORTUNITY_COMPUTED_FIELDS].sort()).toEqual(
      [
        "importDate",
        "productTotal",
        "weightedTotal",
        "grossMargin",
        "daysOpen",
        "daysInStage",
        "contactNames",
        "totalPerContact",
        "totalPerCompany",
        "totalPerGroup",
        "creator",
        "manager",
      ].sort(),
    );
    const writable = writableOpportunity(opportunity());
    for (const field of OPPORTUNITY_COMPUTED_FIELDS) expect(writable).not.toHaveProperty(field);
  });

  it("sends everything else back exactly as read, edited and created included", () => {
    const record = opportunity();
    const writable = writableOpportunity(record);
    const kept = Object.fromEntries(
      Object.entries(record).filter(([field]) => !(OPPORTUNITY_COMPUTED_FIELDS as readonly string[]).includes(field)),
    );
    expect(writable).toEqual(kept);
    expect(writable.edited).toBe("2026-10-12T00:00:00Z");
    expect(writable.recordManager).toBe("John Hollo");
  });

  it("does not touch the record it was given", () => {
    const record = opportunity();
    writableOpportunity(record);
    expect(record).toEqual(opportunity());
  });

  it("does not carry a won deal's old weighted total back with the win", () => {
    const won = wonOpportunityBody("AU", { processId: "2380e83d-cef4-4b6d-ad15-dc9a558431ab", number: 3, status: "Open" }, new Date("2026-10-12T00:00:00Z"));
    if (won.kind !== "patch") throw new Error("expected a patch");
    const body = writableOpportunity(mergeForWrite(ID, opportunity(), won.patch));
    expect(body.status).toBe("Won");
    expect(body).not.toHaveProperty("weightedTotal");
    expect(body).not.toHaveProperty("productTotal");
    expect(body.id).toBe(ID);
  });
});

describe("patchToSend", () => {
  const REVISION = {
    number: "Q-AU-2026-014",
    revision: 1,
    regionCode: "AU",
    total: 47500,
    currency: "AUD",
    validityDays: 30,
    finalizedAt: new Date("2026-10-12T00:00:00Z"),
  };

  it("is null for no decision, and for a patch with nothing in it", () => {
    expect(patchToSend(null, contact())).toBeNull();
    expect(patchToSend({}, contact())).toBeNull();
    expect(patchToSend({ name: undefined, stage: undefined }, contact())).toBeNull();
  });

  it("is the patch itself when anything in it changes the record, a null that clears a field included", () => {
    const patch = { idStatus: "Customer" };
    expect(patchToSend(patch, contact())).toBe(patch);
    const clearing = { reason: null, name: undefined };
    expect(patchToSend(clearing, { id: ID, reason: "Price" })).toBe(clearing);
  });

  it("is null for a patch the record already shows, field for field", () => {
    expect(patchToSend({ idStatus: "Prospect", firstName: "Ann" }, contact())).toBeNull();
    // An id in the patch is never a change: the write is always to the record's own id.
    expect(patchToSend({ id: ID, idStatus: "Prospect" }, contact())).toBeNull();
  });

  it("sends the whole patch when one field of it differs, even if the rest is as read", () => {
    const patch = { idStatus: "Prospect", firstName: "Anne" };
    expect(patchToSend(patch, contact())).toBe(patch);
  });

  it("reads customFields key by key, as mergeForWrite lays them on", () => {
    expect(patchToSend({ customFields: { rep: "John Hollo" } }, contact())).toBeNull();
    expect(patchToSend({ customFields: { rep: "John Hollo", user6: undefined } }, contact())).toBeNull();
    const changed = { customFields: { rep: "Jane Roe" } };
    expect(patchToSend(changed, contact())).toBe(changed);
    const added = { customFields: { owner: "Vadym" } };
    expect(patchToSend(added, contact())).toBe(added);
    const onBare = { customFields: { rep: "John Hollo" } };
    expect(patchToSend(onBare, { ...contact(), customFields: null })).toBe(onBare);
  });

  it("sends nothing for a closed deal's revision: the decision the drain hands in is null", () => {
    const update = revisedOpportunityBody(REVISION, {
      processId: "2380e83d-cef4-4b6d-ad15-dc9a558431ab",
      number: 3,
      status: "Lost",
    });
    expect(patchToSend(update.kind === "patch" ? update.patch : null, opportunity())).toBeNull();
  });

  it("sends nothing for an open deal's revision whose stage stays: the name is no longer renamed", () => {
    const update = revisedOpportunityBody(REVISION, {
      processId: "2380e83d-cef4-4b6d-ad15-dc9a558431ab",
      number: 5,
      status: "Open",
    });
    if (update.kind !== "patch") throw new Error("expected a patch");
    expect(update.patch).toEqual({});
    expect(patchToSend(update.patch, opportunity())).toBeNull();
  });

  it("sends nothing to a line that already shows the revision -- one adopted after a lost create -- and the patch to one that does not", () => {
    const patch = summaryProductPatch(REVISION);
    const line = { id: ID, opportunityID: "o1", type: null, cost: 0, discount: 0, edited: "2026-10-12T00:00:00Z", ...patch };
    expect(patchToSend(patch, line)).toBeNull();
    // ACT! hands a whole number back without its ".0"; JSON makes them one number.
    expect(patchToSend(patch, JSON.parse(JSON.stringify({ ...line, price: 47500.0 })))).toBeNull();
    const older = { ...line, ...summaryProductPatch({ ...REVISION, revision: 0, total: 45000 }) };
    expect(patchToSend(patch, older)).toBe(patch);
  });

  it("sends a stage that is the same id but read back with more fields than the patch carries: not provably the same", () => {
    const stage = { id: "s4", name: "Proposal", probability: 40, number: 4, process: { id: "p1" } };
    const read = { id: ID, stage: { ...stage, description: "Quote sent", process: { id: "p1", name: "Sales Cycle" } } };
    expect(patchToSend({ stage }, read)).toEqual({ stage });
    expect(patchToSend({ stage }, { id: ID, stage })).toBeNull();
  });
});

describe("sameValue", () => {
  it("compares primitives by value, and nested objects and arrays all the way down", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it("does not take null, undefined, 0 or an empty string for one another", () => {
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue(0, "0")).toBe(false);
    expect(sameValue("", null)).toBe(false);
    expect(sameValue(0, false)).toBe(false);
  });

  it("treats a key holding undefined as absent, as the JSON body does", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it("does not take an array for an object, or arrays of different lengths for one another", () => {
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue([1, 2], [1])).toBe(false);
  });
});

describe("writeAnswer", () => {
  it("takes an object with an id as the record", () => {
    const record = { id: ID, name: "x" };
    expect(writeAnswer(record)).toEqual({ kind: "record", record });
  });

  it("takes a bare uuid string as the id to read the record back by", () => {
    expect(writeAnswer(ID)).toEqual({ kind: "id", id: ID });
    expect(writeAnswer(` ${ID}\n`)).toEqual({ kind: "id", id: ID });
  });

  it("is nothing for an empty answer, an object with no id, a list or a string that is not a uuid", () => {
    expect(writeAnswer(null)).toEqual({ kind: "nothing" });
    expect(writeAnswer({})).toEqual({ kind: "nothing" });
    expect(writeAnswer({ id: "" })).toEqual({ kind: "nothing" });
    expect(writeAnswer({ id: 42 })).toEqual({ kind: "nothing" });
    expect(writeAnswer([{ id: ID }])).toEqual({ kind: "nothing" });
    expect(writeAnswer("Created")).toEqual({ kind: "nothing" });
    expect(writeAnswer(true)).toEqual({ kind: "nothing" });
  });
});

describe("odataString", () => {
  it("quotes a value for a $filter, doubling every single quote inside it", () => {
    expect(odataString("Q-AU-2026-014 AUD")).toBe("'Q-AU-2026-014 AUD'");
    expect(odataString("O'Brien's")).toBe("'O''Brien''s'");
    expect(odataString("'")).toBe("''''");
    expect(odataString("")).toBe("''");
  });

  it("survives URLSearchParams as the same literal", () => {
    const filter = `regarding eq ${odataString("Quote Q-AU-2026-014-R2 finalised in PathQuote")}`;
    const query = new URLSearchParams({ $filter: filter }).toString();
    expect(new URLSearchParams(query).get("$filter")).toBe(filter);
  });
});
