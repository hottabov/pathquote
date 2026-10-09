import { describe, it, expect } from "vitest";
import {
  ALL_COUNTRIES,
  companyOwnedWhereForUser,
  companyWhereForUser,
  documentWhereForUser,
} from "../src/lib/scope";

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

// Country-based visibility (decisions D1-D3, 2026-10-08). `companyWhereForUser`
// is the READ and EDIT filter and gains a country arm; `companyOwnedWhereForUser`
// is the DELETE filter and never does. The cases that matter most are the
// ones where a grant is absent or empty: until someone is granted countries
// nothing may change, and an empty list must not be read as "all".
describe("companyWhereForUser with a country grant", () => {
  const manager = { id: "u1", role: "MANAGER" };
  const regional = { id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" };

  describe("no grant: exactly today's rule", () => {
    it("MANAGER with the field absent", () => {
      expect(companyWhereForUser(manager)).toEqual({ ownerId: "u1" });
    });

    it("MANAGER with an empty grant", () => {
      expect(companyWhereForUser({ ...manager, visibleCountries: [] })).toEqual({ ownerId: "u1" });
    });

    it("REGIONAL_MANAGER with the field absent", () => {
      expect(companyWhereForUser(regional)).toEqual({ owner: { regionId: "r-au" } });
    });

    it("REGIONAL_MANAGER with an empty grant", () => {
      expect(companyWhereForUser({ ...regional, visibleCountries: [] })).toEqual({
        owner: { regionId: "r-au" },
      });
    });

    it("ADMIN with the field absent or empty", () => {
      expect(companyWhereForUser({ id: "a", role: "ADMIN" })).toEqual({});
      expect(companyWhereForUser({ id: "a", role: "ADMIN", visibleCountries: [] })).toEqual({});
    });

    it("treats a value that is not an array as no grant", () => {
      // An old session token, or a hand-built user cast past the type.
      const broken = { ...manager, visibleCountries: null as unknown as string[] };
      expect(companyWhereForUser(broken)).toEqual({ ownerId: "u1" });
    });

    it("treats a grant of nothing but blank entries as no grant", () => {
      // `country IN ('')` would match a company whose country was saved blank.
      expect(companyWhereForUser({ ...manager, visibleCountries: ["", "  "] })).toEqual({
        ownerId: "u1",
      });
    });
  });

  // The dangerous mistake. `User.visibleCountries` defaults to `[]`, so a
  // wildcard reading of "empty" shows every new user all ~8,800 clients.
  describe("an empty grant is not all", () => {
    it("is not the unrestricted filter", () => {
      expect(companyWhereForUser({ ...manager, visibleCountries: [] })).not.toEqual({});
      expect(companyWhereForUser({ ...regional, visibleCountries: [] })).not.toEqual({});
    });

    it("still restricts to something, for every non-admin shape", () => {
      for (const user of [manager, regional, { id: "x", role: "SOMETHING_ELSE" }]) {
        const where = companyWhereForUser({ ...user, visibleCountries: [] });
        expect(Object.keys(where).length).toBeGreaterThan(0);
      }
    });

    it("only the explicit wildcard is unrestricted", () => {
      expect(ALL_COUNTRIES).toBe("*");
      expect(companyWhereForUser({ ...manager, visibleCountries: [ALL_COUNTRIES] })).toEqual({});
    });
  });

  describe("a grant adds a country arm", () => {
    it("MANAGER: owns it OR it is in a granted country", () => {
      expect(companyWhereForUser({ ...manager, visibleCountries: ["US", "CA"] })).toEqual({
        OR: [{ ownerId: "u1" }, { country: { in: ["US", "CA"] } }],
      });
    });

    it("keeps the ownership arm, so nothing visible before is taken away", () => {
      const where = companyWhereForUser({ ...manager, visibleCountries: ["MX"] });
      expect(where).toEqual({ OR: [{ ownerId: "u1" }, { country: { in: ["MX"] } }] });
      expect(JSON.stringify(where)).toContain('"ownerId":"u1"');
    });

    it("REGIONAL_MANAGER keeps the region arm and gains the country arm", () => {
      expect(companyWhereForUser({ ...regional, visibleCountries: ["GB"] })).toEqual({
        OR: [{ owner: { regionId: "r-au" } }, { country: { in: ["GB"] } }],
      });
    });

    it("a region-less REGIONAL_MANAGER keeps the fail-closed region arm", () => {
      // The empty region id matches no owner; the country arm is all they get.
      expect(
        companyWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", regionId: null, visibleCountries: ["GB"] })
      ).toEqual({ OR: [{ owner: { regionId: "" } }, { country: { in: ["GB"] } }] });
    });

    it("does not mutate or alias the user's grant", () => {
      const grant = ["US", "CA"];
      const where = companyWhereForUser({ ...manager, visibleCountries: grant });
      grant.push("MX");
      expect(JSON.stringify(where)).not.toContain("MX");
    });
  });

  describe('"*" is every country', () => {
    it("collapses a MANAGER to the unrestricted filter", () => {
      expect(companyWhereForUser({ ...manager, visibleCountries: ["*"] })).toEqual({});
    });

    it("collapses a REGIONAL_MANAGER to the unrestricted filter", () => {
      expect(companyWhereForUser({ ...regional, visibleCountries: ["*"] })).toEqual({});
    });

    it("wins when listed beside other codes", () => {
      expect(companyWhereForUser({ ...manager, visibleCountries: ["US", "*"] })).toEqual({});
    });
  });

  describe("admin is unaffected by a grant", () => {
    it("ADMIN and DEVELOPER stay unrestricted", () => {
      expect(companyWhereForUser({ id: "a", role: "ADMIN", visibleCountries: ["US"] })).toEqual({});
      expect(companyWhereForUser({ id: "d", role: "DEVELOPER", visibleCountries: ["US"] })).toEqual({});
    });
  });
});

// The delete filter. D2: a country grant must never let a manager delete a
// company they do not own, including the grant that makes their read filter
// as wide as an admin's.
describe("companyOwnedWhereForUser", () => {
  const grants = [undefined, [], ["US", "CA"], ["*"]];

  it("is today's ownership rule for a MANAGER, whatever the grant", () => {
    for (const visibleCountries of grants) {
      expect(companyOwnedWhereForUser({ id: "u1", role: "MANAGER", visibleCountries })).toEqual({
        ownerId: "u1",
      });
    }
  });

  it("is today's region rule for a REGIONAL_MANAGER, whatever the grant", () => {
    for (const visibleCountries of grants) {
      expect(
        companyOwnedWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au", visibleCountries })
      ).toEqual({ owner: { regionId: "r-au" } });
    }
  });

  it("is unrestricted for an ADMIN and a DEVELOPER, whatever the grant", () => {
    for (const visibleCountries of grants) {
      expect(companyOwnedWhereForUser({ id: "a", role: "ADMIN", visibleCountries })).toEqual({});
      expect(companyOwnedWhereForUser({ id: "d", role: "DEVELOPER", visibleCountries })).toEqual({});
    }
  });

  it("never mentions a country", () => {
    for (const visibleCountries of grants) {
      const where = companyOwnedWhereForUser({ id: "u1", role: "MANAGER", visibleCountries });
      expect(JSON.stringify(where)).not.toContain("country");
    }
  });

  it("fails closed for a region-less REGIONAL_MANAGER", () => {
    expect(
      companyOwnedWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", visibleCountries: ["*"] })
    ).toEqual({ owner: { regionId: "" } });
  });

  it('stays narrower than the read filter for a manager holding "*"', () => {
    const manager = { id: "u1", role: "MANAGER", visibleCountries: ["*"] };
    expect(companyWhereForUser(manager)).toEqual({});
    expect(companyOwnedWhereForUser(manager)).toEqual({ ownerId: "u1" });
  });

  it("equals companyWhereForUser when there is no grant, so the two cannot drift", () => {
    for (const user of [
      { id: "u1", role: "MANAGER" },
      { id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" },
      { id: "a", role: "ADMIN" },
    ]) {
      expect(companyOwnedWhereForUser(user)).toEqual(companyWhereForUser(user));
    }
  });
});
