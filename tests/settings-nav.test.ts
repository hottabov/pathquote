import { describe, it, expect } from "vitest";
import {
  activeSettingsNavHref,
  visibleSettingsNavItems,
  SETTINGS_NAV_ITEMS,
} from "../src/lib/settings-nav";
import { isAdminRole } from "../src/lib/roles";

describe("visibleSettingsNavItems", () => {
  it("includes every section for an ADMIN", () => {
    const items = visibleSettingsNavItems("ADMIN");
    expect(items.map((i) => i.label)).toEqual(SETTINGS_NAV_ITEMS.map((i) => i.label));
  });

  it("includes every section for a DEVELOPER, same as an ADMIN", () => {
    const items = visibleSettingsNavItems("DEVELOPER");
    expect(items.map((i) => i.label)).toEqual(SETTINGS_NAV_ITEMS.map((i) => i.label));
  });

  it("omits admin-only sections for a MANAGER, but keeps the open ones", () => {
    const items = visibleSettingsNavItems("MANAGER");
    expect(items.map((i) => i.label)).toEqual(["Account", "Preferences", "PathQuote Support"]);
  });

  it("treats a missing role the same as a non-admin", () => {
    const expected = ["Account", "Preferences", "PathQuote Support"];
    expect(visibleSettingsNavItems(null).map((i) => i.label)).toEqual(expected);
    expect(visibleSettingsNavItems(undefined).map((i) => i.label)).toEqual(expected);
  });

  it("never gates PathQuote Support behind admin rights — anyone can reach the developer", () => {
    for (const role of ["ADMIN", "DEVELOPER", "MANAGER", null, undefined]) {
      expect(visibleSettingsNavItems(role).map((i) => i.label)).toContain("PathQuote Support");
    }
  });
});

describe("activeSettingsNavHref", () => {
  it("puts the area root on Account", () => {
    expect(activeSettingsNavHref("/settings")).toBe("/settings");
  });

  it("does NOT leave Account active on a sibling section", () => {
    // The regression this function exists for: Account's href is the area
    // root, so a plain prefix test matched every settings page.
    for (const path of [
      "/settings/preferences",
      "/settings/users",
      "/settings/content",
      "/settings/regions",
      "/settings/support",
    ]) {
      expect(activeSettingsNavHref(path)).toBe(path);
    }
  });

  it("keeps a section active on its own nested routes", () => {
    expect(activeSettingsNavHref("/settings/users/abc123")).toBe("/settings/users");
    expect(activeSettingsNavHref("/settings/regions/AU/edit")).toBe("/settings/regions");
  });

  it("honours activePrefixes — conflict groups light up Catalogue", () => {
    expect(activeSettingsNavHref("/settings/option-conflict-groups")).toBe("/settings/content");
    expect(activeSettingsNavHref("/settings/option-conflict-groups/g1")).toBe("/settings/content");
  });

  it("honours activePrefixes — spec diagrams also light up Catalogue", () => {
    expect(activeSettingsNavHref("/settings/spec-images")).toBe("/settings/content");
  });

  it("only matches at a segment boundary, not mid-segment", () => {
    // `/settings/users` must not swallow a hypothetical sibling whose path
    // merely starts with the same characters.
    expect(activeSettingsNavHref("/settings/users-archive")).toBe("/settings");
  });

  it("returns null outside Settings", () => {
    expect(activeSettingsNavHref("/catalog/options")).toBeNull();
    expect(activeSettingsNavHref("/")).toBeNull();
    // A path that merely starts with the same characters is not inside it.
    expect(activeSettingsNavHref("/settings-export")).toBeNull();
  });

  it("resolves against the caller's visible items, not the full list", () => {
    // A MANAGER never renders Users, so a Users path must not resolve to an
    // item that isn't on their screen.
    const managerItems = visibleSettingsNavItems("MANAGER");
    expect(activeSettingsNavHref("/settings/preferences", managerItems)).toBe(
      "/settings/preferences"
    );
    expect(activeSettingsNavHref("/settings/users", managerItems)).toBe("/settings");
  });
});


// --- was tests/roles.test.ts: isAdminRole (src/lib/roles.ts) ------------------

describe("isAdminRole", () => {
  it("returns true for ADMIN", () => {
    expect(isAdminRole("ADMIN")).toBe(true);
  });

  it("returns true for DEVELOPER", () => {
    expect(isAdminRole("DEVELOPER")).toBe(true);
  });

  it("returns false for MANAGER", () => {
    expect(isAdminRole("MANAGER")).toBe(false);
  });

  it("returns false for null/undefined/an unrecognised role", () => {
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole("SOMETHING_ELSE")).toBe(false);
  });
});
