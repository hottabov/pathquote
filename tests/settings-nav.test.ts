import { describe, it, expect } from "vitest";
import {
  activeSettingsNavHref,
  visibleSettingsNavItems,
  SETTINGS_NAV_ITEMS,
} from "../src/lib/settings-nav";
import { canSeeActSync, isAdminRole, isDeveloperRole } from "../src/lib/roles";

/** A viewer an admin HAS ticked "Show the ACT! sync section" for. */
const granted = (role: string | null | undefined) => ({ role, actSyncVisible: true });
/** A viewer an admin has NOT ticked it for — the default for a new account,
 * and the distributor this per-user gate exists for. */
const ungranted = (role: string | null | undefined) => ({ role, actSyncVisible: false });

describe("visibleSettingsNavItems", () => {
  it("includes every section for an ADMIN, whatever their own ACT! sync flag says", () => {
    // `ungranted` on purpose: an admin gets the section by role, so an admin
    // whose column happens to be false must still see it. Nobody can lock an
    // administrator out of the page the flag is set on.
    for (const viewer of [granted("ADMIN"), ungranted("ADMIN")]) {
      const items = visibleSettingsNavItems(viewer);
      expect(items.map((i) => i.label)).toEqual(SETTINGS_NAV_ITEMS.map((i) => i.label));
    }
  });

  it("includes every section for a DEVELOPER, same as an ADMIN", () => {
    for (const viewer of [granted("DEVELOPER"), ungranted("DEVELOPER")]) {
      const items = visibleSettingsNavItems(viewer);
      expect(items.map((i) => i.label)).toEqual(SETTINGS_NAV_ITEMS.map((i) => i.label));
    }
  });

  it("omits admin-only sections for a granted MANAGER, but keeps the open ones", () => {
    // Three sections for a manager who has been given ACT! sync, and the
    // middle one is the one that is not simply open: ACT! sync reports on a job
    // and offers one harmless button, where Preferences went the other way into
    // the admin set (its values are business-wide defaults a manager cannot
    // change). See `adminOnly` in src/lib/settings-nav.ts.
    const items = visibleSettingsNavItems(granted("MANAGER"));
    expect(items.map((i) => i.label)).toEqual(["Account", "ACT! sync", "PathQuote Support"]);
  });

  it("treats a missing role the same as a non-admin", () => {
    const expected = ["Account", "ACT! sync", "PathQuote Support"];
    expect(visibleSettingsNavItems(granted(null)).map((i) => i.label)).toEqual(expected);
    expect(visibleSettingsNavItems(granted(undefined)).map((i) => i.label)).toEqual(expected);
    // And an unrecognised role with no grant gets the two genuinely open ones.
    expect(visibleSettingsNavItems(ungranted(null)).map((i) => i.label)).toEqual([
      "Account",
      "PathQuote Support",
    ]);
  });

  it("never gates PathQuote Support behind admin rights — anyone can reach the developer", () => {
    for (const role of ["ADMIN", "DEVELOPER", "MANAGER", "REGIONAL_MANAGER", null, undefined]) {
      // Both flag values: PathQuote Support has no per-user gate at all, and
      // must not acquire one by accident when another section gets one.
      expect(visibleSettingsNavItems(granted(role)).map((i) => i.label)).toContain(
        "PathQuote Support"
      );
      expect(visibleSettingsNavItems(ungranted(role)).map((i) => i.label)).toContain(
        "PathQuote Support"
      );
    }
  });

  it("gives ACT! sync the only per-user gate, and gives it `canSeeActSync` itself", () => {
    // The nav and the two server-side guards agree because they are the same
    // function, not because two copies of one rule were kept in step:
    // `requireActSyncPage` and `requireActSync` (src/lib/authz.ts) call
    // `canSeeActSync` too. A second `visibleTo` appearing here is a new
    // per-user permission, which wants its own tests above, so this fails and
    // asks for them.
    const gated = SETTINGS_NAV_ITEMS.filter((i) => i.visibleTo !== undefined);
    expect(gated.map((i) => i.href)).toEqual(["/settings/act-sync"]);
    expect(gated[0].visibleTo).toBe(canSeeActSync);
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
      "/settings/option-conflict-groups",
      "/settings/regions",
      "/settings/import-export",
      "/settings/act-sync",
      "/settings/support",
    ]) {
      expect(activeSettingsNavHref(path)).toBe(path);
    }
  });

  it("does NOT gate ACT! sync behind admin rights -- it is operational status, not settings", () => {
    // It was adminOnly until managers were given it. The flag is asserted
    // directly as well as through the filter so flipping it back fails here
    // rather than only in the tests below.
    const item = SETTINGS_NAV_ITEMS.find((i) => i.href === "/settings/act-sync");
    expect(item).toBeDefined();
    expect(item!.label).toBe("ACT! sync");
    expect(item!.adminOnly).toBe(false);
    expect(visibleSettingsNavItems(ungranted("ADMIN")).map((i) => i.href)).toContain(
      "/settings/act-sync"
    );
  });

  it("shows ACT! sync to a granted MANAGER -- the decision this section was opened for", () => {
    // Half of the decision this section's permission holds: a manager who can
    // see that an ACT! edit of theirs has not reached PathQuote reaches this
    // page, and the Sync now button on it, without having to ask the
    // developer. A REGIONAL_MANAGER is a MANAGER plus a wider row scope
    // (isRegionalManagerRole, src/lib/roles.ts) and gets it for the same
    // reason.
    for (const role of ["MANAGER", "REGIONAL_MANAGER"]) {
      expect(visibleSettingsNavItems(granted(role)).map((i) => i.href)).toContain(
        "/settings/act-sync"
      );
    }
  });

  it("hides ACT! sync from an ungranted MANAGER -- the distributor this gate exists for", () => {
    // The other half, and the reason the per-user column exists at all. A
    // distributor is an outside reseller holding MANAGER: no ACT! licence, no
    // ACT! access, contacts pushed into ACT! for them when they finalise a
    // quote. A page reporting on that CRM means nothing to them and a button
    // to sync it is worse, so an admin leaves the tick off and they never see
    // the row. No role tells them apart from a real manager, which is why
    // `adminOnly: false` alone is not the answer -- and why a default of
    // `false` on the column (prisma/schema.prisma) is what makes a brand-new
    // distributor hidden without anybody remembering to hide them.
    //
    // This is held by a test rather than only by that default so that
    // widening the rule back to "every signed-in user" has to argue with
    // something.
    for (const role of ["MANAGER", "REGIONAL_MANAGER"]) {
      const hrefs = visibleSettingsNavItems(ungranted(role)).map((i) => i.href);
      expect(hrefs).not.toContain("/settings/act-sync");
      // And nothing else went with it: they keep the two genuinely open ones.
      expect(hrefs).toEqual(["/settings", "/settings/support"]);
    }
  });

  it("resolves an ungranted viewer's path off their own items, so ACT! sync cannot light up", () => {
    // Belt and braces for the nav highlight: an ungranted manager who somehow
    // lands on the path (a bookmark, a pasted link -- the page 404s them, but
    // the layout renders around it) must not have a row highlighted that is
    // not on their screen. It falls back to Account, the area root.
    const items = visibleSettingsNavItems(ungranted("MANAGER"));
    expect(activeSettingsNavHref("/settings/act-sync", items)).toBe("/settings");
  });

  it("puts ACT! sync straight after Import / Export", () => {
    // Both are operational rather than lists to curate, and the order is what
    // keeps them together: the nav is read top to bottom, and a reporting
    // section wedged between two editors reads as another editor.
    const hrefs = SETTINGS_NAV_ITEMS.map((i) => i.href);
    expect(hrefs.indexOf("/settings/act-sync")).toBe(hrefs.indexOf("/settings/import-export") + 1);
  });

  it("gates Import / Export behind admin rights -- it deletes catalogue rows", () => {
    const item = SETTINGS_NAV_ITEMS.find((i) => i.href === "/settings/import-export");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Import / Export");
    expect(item!.adminOnly).toBe(true);
    // Granted on purpose: the ACT! sync grant must not widen anything else.
    expect(visibleSettingsNavItems(granted("MANAGER")).map((i) => i.href)).not.toContain("/settings/import-export");
    expect(visibleSettingsNavItems(ungranted("ADMIN")).map((i) => i.href)).toContain("/settings/import-export");
  });

  it("keeps a section active on its own nested routes", () => {
    expect(activeSettingsNavHref("/settings/users/abc123")).toBe("/settings/users");
    expect(activeSettingsNavHref("/settings/regions/AU/edit")).toBe("/settings/regions");
  });

  it("keeps Catalogue active on a conflict group's own nested route", () => {
    expect(activeSettingsNavHref("/settings/option-conflict-groups/g1")).toBe("/settings/option-conflict-groups");
  });

  it("honours activePrefixes — spec diagrams also light up Catalogue", () => {
    expect(activeSettingsNavHref("/settings/spec-images")).toBe("/settings/option-conflict-groups");
  });

  it("has no nav item left pointing at the deleted /settings/content route", () => {
    // z37_drop_content_block deleted that route with the ContentBlock table.
    // A nav entry surviving it would 404 every admin who clicked Catalogue.
    for (const item of SETTINGS_NAV_ITEMS) {
      expect(item.href).not.toBe("/settings/content");
      expect(item.activePrefixes ?? []).not.toContain("/settings/content");
    }
    expect(activeSettingsNavHref("/settings/content")).toBe("/settings");
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
    // A MANAGER never renders Users or Preferences, so a path under either
    // must not resolve to an item that isn't on their screen — it falls back
    // to Account, the area root, instead.
    const managerItems = visibleSettingsNavItems(granted("MANAGER"));
    expect(activeSettingsNavHref("/settings/preferences", managerItems)).toBe("/settings");
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

// isDeveloperRole (src/lib/roles.ts) -- added alongside `canDeleteDocument`'s
// DEVELOPER-only exception for deleting a SIGNED quote (src/lib/signing/state.ts).
describe("isDeveloperRole", () => {
  it("returns true for DEVELOPER", () => {
    expect(isDeveloperRole("DEVELOPER")).toBe(true);
  });

  it("returns false for ADMIN, unlike isAdminRole", () => {
    expect(isDeveloperRole("ADMIN")).toBe(false);
  });

  it("returns false for MANAGER", () => {
    expect(isDeveloperRole("MANAGER")).toBe(false);
  });

  it("returns false for null/undefined/an unrecognised role", () => {
    expect(isDeveloperRole(null)).toBe(false);
    expect(isDeveloperRole(undefined)).toBe(false);
    expect(isDeveloperRole("SOMETHING_ELSE")).toBe(false);
  });
});

// canSeeActSync (src/lib/roles.ts) -- the one decision behind all three gates
// on the ACT! sync section: the nav row (visibleSettingsNavItems above),
// the page (requireActSyncPage) and the Sync now action (requireActSync),
// both in src/lib/authz.ts.
describe("canSeeActSync", () => {
  it("is true for an ADMIN or DEVELOPER whatever their flag says", () => {
    // The point of the role short-circuit: an admin cannot be locked out of
    // the section, including by their own column being false, so the checkbox
    // on an admin's page is meaningless rather than dangerous.
    for (const role of ["ADMIN", "DEVELOPER"]) {
      expect(canSeeActSync({ role, actSyncVisible: true })).toBe(true);
      expect(canSeeActSync({ role, actSyncVisible: false })).toBe(true);
    }
  });

  it("is the flag, and only the flag, for everybody else", () => {
    for (const role of ["MANAGER", "REGIONAL_MANAGER", "SOMETHING_ELSE", null, undefined]) {
      expect(canSeeActSync({ role, actSyncVisible: true })).toBe(true);
      expect(canSeeActSync({ role, actSyncVisible: false })).toBe(false);
    }
  });

  it("refuses an ungranted MANAGER -- the distributor case, at the decision itself", () => {
    // The same decision tests/settings-nav's nav test holds, asserted here on
    // the predicate the page guard and the action guard call. A distributor
    // typing /settings/act-sync gets a 404 and a replayed POST to
    // runActSyncNow's id gets a refusal, both off this one `false`.
    expect(canSeeActSync({ role: "MANAGER", actSyncVisible: false })).toBe(false);
  });
});
