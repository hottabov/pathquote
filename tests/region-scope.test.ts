import { describe, it, expect } from "vitest";
import {
  regionIdForUser,
  priceWhereForUser,
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
});
