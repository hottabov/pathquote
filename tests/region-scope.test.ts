import { describe, it, expect } from "vitest";
import {
  regionIdForUser,
  priceWhereForUser,
  priceRegionIdForUser,
  assertRegionWritable,
  REGION_REQUIRED_ERROR,
  FOREIGN_REGION_ERROR,
} from "../src/lib/scope";

const admin = { id: "u1", role: "ADMIN", regionId: "r-au" };
const developer = { id: "u2", role: "DEVELOPER", regionId: null };
const manager = { id: "u3", role: "MANAGER", regionId: "r-au" };
const managerNoRegion = { id: "u4", role: "MANAGER", regionId: null };

describe("regionIdForUser", () => {
  it("returns null for an ADMIN, meaning every region", () => {
    expect(regionIdForUser(admin)).toBeNull();
  });

  it("returns null for a DEVELOPER, same as an ADMIN", () => {
    expect(regionIdForUser(developer)).toBeNull();
  });

  it("returns the manager's own region", () => {
    expect(regionIdForUser(manager)).toBe("r-au");
  });

  it("returns null for a manager with no region, which callers must treat as blocked", () => {
    expect(regionIdForUser(managerNoRegion)).toBeNull();
  });
});

describe("priceWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(priceWhereForUser(admin)).toEqual({});
  });

  it("returns no restriction for a DEVELOPER", () => {
    expect(priceWhereForUser(developer)).toEqual({});
  });

  it("restricts to the manager's region", () => {
    expect(priceWhereForUser(manager)).toEqual({ regionId: "r-au" });
  });

  it("restricts a region-less manager to a region id that matches nothing", () => {
    expect(priceWhereForUser(managerNoRegion)).toEqual({ regionId: "" });
  });
});

// The catalogue's price table filters an in-memory region list by this
// value, so what it returns for a viewer with no region decides whether
// that viewer sees nothing or sees every region's prices. `""` must reach
// the caller intact — see the helper's own comment on `??` vs `||`.
describe("priceRegionIdForUser", () => {
  it("returns null for an ADMIN, meaning every region", () => {
    expect(priceRegionIdForUser(admin)).toBeNull();
  });

  it("returns null for a DEVELOPER", () => {
    expect(priceRegionIdForUser(developer)).toBeNull();
  });

  it("returns the manager's own region", () => {
    expect(priceRegionIdForUser(manager)).toBe("r-au");
  });

  it("returns the unmatchable empty id — NOT null — for a manager with no region", () => {
    expect(priceRegionIdForUser(managerNoRegion)).toBe("");
  });

  it("returns the unmatchable empty id for an unknown non-admin role", () => {
    expect(priceRegionIdForUser({ id: "u7", role: "SOMETHING_ELSE", regionId: null })).toBe("");
  });
});

describe("assertRegionWritable", () => {
  it("lets an ADMIN write into any region", () => {
    expect(() => assertRegionWritable(admin, "r-us")).not.toThrow();
  });

  it("lets a DEVELOPER write into any region", () => {
    expect(() => assertRegionWritable(developer, "r-us")).not.toThrow();
  });

  it("lets a manager write into their own region", () => {
    expect(() => assertRegionWritable(manager, "r-au")).not.toThrow();
  });

  it("blocks a manager writing into another region", () => {
    expect(() => assertRegionWritable(manager, "r-us")).toThrow(FOREIGN_REGION_ERROR);
  });

  it("blocks a manager with no region from writing anywhere", () => {
    expect(() => assertRegionWritable(managerNoRegion, "r-au")).toThrow(REGION_REQUIRED_ERROR);
  });

  // An unrecognised role must fall to the non-admin path, not slip through
  // a role check that only knows the roles it was written against. The
  // ownership axis pins this in tests/scope.test.ts; these are the *write*
  // guards, so pin it here too rather than trusting the shared helper.
  it("treats an unknown role as a non-admin", () => {
    const stranger = { id: "u5", role: "SOMETHING_ELSE", regionId: "r-au" };
    expect(() => assertRegionWritable(stranger, "r-us")).toThrow(FOREIGN_REGION_ERROR);
    expect(() => assertRegionWritable(stranger, "r-au")).not.toThrow();
  });

  // An empty target region is a caller bug, not a wildcard. Pinned because
  // `priceWhereForUser` uses "" as its no-region sentinel, and the two
  // helpers must not quietly agree that "" means "anywhere".
  it("does not treat an empty target region as a match", () => {
    expect(() => assertRegionWritable(manager, "")).toThrow(FOREIGN_REGION_ERROR);
  });

  it("reports a missing region as missing even when it arrives as undefined", () => {
    const undefinedRegion = { id: "u6", role: "MANAGER", regionId: undefined as unknown as null };
    expect(() => assertRegionWritable(undefinedRegion, "r-au")).toThrow(REGION_REQUIRED_ERROR);
  });
});
