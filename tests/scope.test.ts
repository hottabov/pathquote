import { describe, it, expect } from "vitest";
import { companyWhereForUser, documentWhereForUser } from "../src/lib/scope";

describe("companyWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(companyWhereForUser({ id: "u1", role: "ADMIN" })).toEqual({});
  });

  it("returns no restriction for a DEVELOPER, same as an ADMIN", () => {
    expect(companyWhereForUser({ id: "u1", role: "DEVELOPER" })).toEqual({});
  });

  it("restricts to ownerId for a MANAGER", () => {
    expect(companyWhereForUser({ id: "u1", role: "MANAGER" })).toEqual({ ownerId: "u1" });
  });

  it("restricts to ownerId for any non-admin role", () => {
    expect(companyWhereForUser({ id: "u2", role: "SOMETHING_ELSE" })).toEqual({ ownerId: "u2" });
  });

  // Company has no region column of its own, deliberately (see the schema
  // comment on `model Company`). A client belongs to the manager who looks
  // after it, so "this region's clients" can only mean "owned by a user of
  // this region" -- which also means a company with no owner is invisible to
  // a regional manager, and stays admin-only. That is intended.
  it("restricts a REGIONAL_MANAGER to companies owned by a user of their region", () => {
    expect(
      companyWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" })
    ).toEqual({ owner: { regionId: "r-au" } });
  });

  it("does not also restrict a REGIONAL_MANAGER to their own companies", () => {
    const where = companyWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" });
    expect(where).not.toHaveProperty("ownerId");
  });

  // Fail closed, exactly as `priceWhereForUser` does: an empty region id is
  // an id no row can hold, so the list is empty rather than everything.
  it("restricts a region-less REGIONAL_MANAGER to a region id that matches nothing", () => {
    expect(companyWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", regionId: null })).toEqual({
      owner: { regionId: "" },
    });
    expect(companyWhereForUser({ id: "u4", role: "REGIONAL_MANAGER" })).toEqual({
      owner: { regionId: "" },
    });
  });
});

describe("documentWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(documentWhereForUser({ id: "u1", role: "ADMIN" })).toEqual({});
  });

  it("returns no restriction for a DEVELOPER, same as an ADMIN", () => {
    expect(documentWhereForUser({ id: "u1", role: "DEVELOPER" })).toEqual({});
  });

  it("restricts to authorId for a MANAGER", () => {
    expect(documentWhereForUser({ id: "u1", role: "MANAGER" })).toEqual({ authorId: "u1" });
  });

  it("restricts to authorId for any non-admin role", () => {
    expect(documentWhereForUser({ id: "u2", role: "SOMETHING_ELSE" })).toEqual({ authorId: "u2" });
  });

  // `Document.regionId` is frozen at creation from the author's own region
  // (see `createDraft`, src/lib/actions/documents/lifecycle.ts), so filtering
  // on it IS "written by someone who was in this region then" -- and it keeps
  // a quote with the region whose books it belongs to even after its author
  // moves. It is also the indexed column (`@@index([regionId, status])`),
  // where `author: { regionId }` would be a join.
  it("restricts a REGIONAL_MANAGER to their region's quotes", () => {
    expect(
      documentWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" })
    ).toEqual({ regionId: "r-au" });
  });

  it("does not also restrict a REGIONAL_MANAGER to their own quotes", () => {
    const where = documentWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" });
    expect(where).not.toHaveProperty("authorId");
  });

  it("restricts a region-less REGIONAL_MANAGER to a region id that matches nothing", () => {
    expect(documentWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", regionId: null })).toEqual({
      regionId: "",
    });
    expect(documentWhereForUser({ id: "u4", role: "REGIONAL_MANAGER" })).toEqual({ regionId: "" });
  });

  // The filter is shared by reads and writes -- every mutating action spreads
  // it into its own `where` (see src/lib/actions/documents/*.ts). This test
  // exists to state that in the test file rather than only in a comment: a
  // regional manager editing a colleague's draft is the intended behaviour,
  // not an oversight, and narrowing this function later silently removes it.
  it("gives a REGIONAL_MANAGER the same filter for a write as for a read", () => {
    const user = { id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" };
    expect(documentWhereForUser(user)).toEqual(documentWhereForUser({ ...user }));
    expect(documentWhereForUser(user)).toEqual({ regionId: "r-au" });
  });
});

// The rules in docs/reference/client-ownership-and-regional-scope.md, stated
// as assertions so a future edit to `companyWhereForUser` cannot quietly
// break them. These are about the SHAPE of the filter, which is what makes
// each rule true — no database needed.
describe("what a regional manager's client filter implies", () => {
  const rm = { id: "rm", role: "REGIONAL_MANAGER", regionId: "r-au" };

  // Rule 1: visibility is computed from the owner's CURRENT region, so a
  // deactivated leaver's clients stay visible as long as that column does.
  // Nothing in the filter references `active`.
  it("does not filter on whether the owner can still sign in", () => {
    expect(companyWhereForUser(rm).owner).toEqual({ regionId: "r-au" });
    expect(JSON.stringify(companyWhereForUser(rm))).not.toContain("active");
  });

  // Rule 2: an owner-less company matches no regional manager. A relation
  // filter on `owner` cannot match a null relation, so this holds by
  // construction — the assertion is that the filter keeps going through the
  // relation rather than being flattened to an `ownerId in (...)` list, which
  // is where a "helpful" optimisation would start matching nulls.
  it("filters through the owner relation, so an owner-less company never matches", () => {
    const where = companyWhereForUser(rm);
    expect(where).toHaveProperty("owner");
    expect(where).not.toHaveProperty("ownerId");
  });
});
