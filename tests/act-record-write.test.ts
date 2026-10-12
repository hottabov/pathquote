import { describe, it, expect } from "vitest";
import { isRetried, mergeForWrite, writeAnswer } from "../src/lib/act/record-write";
import { lostOpportunityBody, wonOpportunityBody } from "../src/lib/act/write-payloads";

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
      name: "Q-AU-2026-014 — AUD 45,000.00",
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
