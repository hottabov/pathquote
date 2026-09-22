import { describe, expect, it } from "vitest";
import { builderTabsFor, parseTab } from "@/lib/builder-tabs";

describe("builderTabsFor", () => {
  it("gives a draft three tabs, with no Order forms among them", () => {
    expect(builderTabsFor({ isFinal: false })).toEqual(["build", "terms", "history"]);
  });

  it("adds Order forms once the quote is final", () => {
    expect(builderTabsFor({ isFinal: true })).toEqual(["build", "terms", "forms", "history"]);
  });

  it("keeps Order forms before History", () => {
    // The forms are a job to do; History is a record of what happened. The
    // job comes first, and the order is the only thing saying so.
    const tabs = builderTabsFor({ isFinal: true });
    expect(tabs.indexOf("forms")).toBeLessThan(tabs.indexOf("history"));
  });
});

describe("parseTab", () => {
  it("reads a tab this quote has", () => {
    expect(parseTab("terms", builderTabsFor({ isFinal: false }))).toBe("terms");
    expect(parseTab("forms", builderTabsFor({ isFinal: true }))).toBe("forms");
  });

  it("falls back to Build for a tab this quote does not have", () => {
    // The case this exists for: ?tab=forms left over from before an
    // Unfinalize, or pasted from a colleague's finalised copy. It has to
    // land on Build, not on a panel that renders nothing.
    expect(parseTab("forms", builderTabsFor({ isFinal: false }))).toBe("build");
  });

  it("falls back to Build for nonsense, an empty value and an array", () => {
    expect(parseTab("nope")).toBe("build");
    expect(parseTab(undefined)).toBe("build");
    expect(parseTab(null)).toBe("build");
    expect(parseTab([])).toBe("build");
  });

  it("takes the first value when the query string repeats the parameter", () => {
    expect(parseTab(["history", "terms"])).toBe("history");
  });

  it("defaults to every tab when the caller does not narrow it", () => {
    // The tab strip only ever renders tabs the page handed it, so it can
    // call this without repeating the status.
    expect(parseTab("forms")).toBe("forms");
  });
});
