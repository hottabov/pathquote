import { describe, it, expect } from "vitest";
import {
  isAdminRole,
  isDeveloperRole,
  isRegionalManagerRole,
  canSeeSalesperson,
  roleLabel,
  scopeDescription,
} from "../src/lib/roles";

describe("isAdminRole", () => {
  it("is true for ADMIN and DEVELOPER", () => {
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("DEVELOPER")).toBe(true);
  });

  // The single most important assertion in this file. A REGIONAL_MANAGER is a
  // manager with a wider view, not a junior admin: the catalogue editor,
  // region settings, industry renames, user administration, import/export,
  // uploads and signed-quote deletion are all gated on `isAdminRole` at their
  // own call sites, and every one of them must stay shut.
  it("is false for REGIONAL_MANAGER — the wider read scope grants no admin rights", () => {
    expect(isAdminRole("REGIONAL_MANAGER")).toBe(false);
  });

  it("is false for MANAGER, an unknown role, null and undefined", () => {
    expect(isAdminRole("MANAGER")).toBe(false);
    expect(isAdminRole("SUPERADMIN")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe("isDeveloperRole", () => {
  it("is true for DEVELOPER only", () => {
    expect(isDeveloperRole("DEVELOPER")).toBe(true);
    expect(isDeveloperRole("ADMIN")).toBe(false);
    expect(isDeveloperRole("REGIONAL_MANAGER")).toBe(false);
    expect(isDeveloperRole("MANAGER")).toBe(false);
  });
});

describe("isRegionalManagerRole", () => {
  it("is true for REGIONAL_MANAGER only", () => {
    expect(isRegionalManagerRole("REGIONAL_MANAGER")).toBe(true);
    expect(isRegionalManagerRole("MANAGER")).toBe(false);
    expect(isRegionalManagerRole("ADMIN")).toBe(false);
    expect(isRegionalManagerRole("DEVELOPER")).toBe(false);
    expect(isRegionalManagerRole(null)).toBe(false);
    expect(isRegionalManagerRole(undefined)).toBe(false);
  });
});

describe("canSeeSalesperson", () => {
  it("is true for every role that can see more than its own quotes", () => {
    expect(canSeeSalesperson("ADMIN")).toBe(true);
    expect(canSeeSalesperson("DEVELOPER")).toBe(true);
    expect(canSeeSalesperson("REGIONAL_MANAGER")).toBe(true);
  });

  // A MANAGER only ever sees their own quotes, so the column would be one
  // name repeated down the page.
  it("is false for MANAGER", () => {
    expect(canSeeSalesperson("MANAGER")).toBe(false);
  });

  // Allow-set, not deny-set: an unrecognised role gets the narrow view.
  it("is false for an unknown role, null and undefined", () => {
    expect(canSeeSalesperson("SUPERADMIN")).toBe(false);
    expect(canSeeSalesperson(null)).toBe(false);
    expect(canSeeSalesperson(undefined)).toBe(false);
  });
});

describe("roleLabel", () => {
  it("renders each known role in sentence case", () => {
    expect(roleLabel("ADMIN")).toBe("Admin");
    expect(roleLabel("MANAGER")).toBe("Manager");
    expect(roleLabel("REGIONAL_MANAGER")).toBe("Regional manager");
    expect(roleLabel("DEVELOPER")).toBe("Developer");
  });

  // A badge must never render empty: an unknown value prints itself.
  it("falls back to the raw value for an unknown role, and to an empty string for nothing", () => {
    expect(roleLabel("SUPERADMIN")).toBe("SUPERADMIN");
    expect(roleLabel(null)).toBe("");
    expect(roleLabel(undefined)).toBe("");
  });
});

describe("scopeDescription", () => {
  const copy = { everything: "all", region: "region", own: "mine" };

  it("gives an admin and a developer the everything line", () => {
    expect(scopeDescription("ADMIN", copy)).toBe("all");
    expect(scopeDescription("DEVELOPER", copy)).toBe("all");
  });

  it("gives a regional manager the region line", () => {
    expect(scopeDescription("REGIONAL_MANAGER", copy)).toBe("region");
  });

  // Same fail-narrow default as the scoping functions: an unrecognised role
  // is described as seeing only its own rows, which is what it will see.
  it("gives a manager, an unknown role and no role the own line", () => {
    expect(scopeDescription("MANAGER", copy)).toBe("mine");
    expect(scopeDescription("SUPERADMIN", copy)).toBe("mine");
    expect(scopeDescription(null, copy)).toBe("mine");
  });
});
