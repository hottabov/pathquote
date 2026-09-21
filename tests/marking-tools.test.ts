import { describe, it, expect } from "vitest";
import {
  MARKING_TOOL_ROLES,
  markingToolConflict,
  markingToolReplacingMrk,
  markingToolsAmong,
  mrkFitted,
} from "../src/lib/production-forms/marking-tools";

/**
 * One mount, one tool: MRK is fitted to every L-Series as standard and comes
 * off when the ink jet printer, the JetPen or the air brush is ordered.
 */
describe("which marking tool is fitted", () => {
  it("keeps MRK on a machine with no marking tool ordered", () => {
    expect(mrkFitted(["HDC", "PM", null])).toBe(true);
    expect(markingToolReplacingMrk(["HDC", "PM"])).toBeNull();
  });

  it.each(["IJP", "JTP", "ABR"] as const)("takes MRK off when %s is ordered", (tool) => {
    expect(markingToolReplacingMrk(["HDC", tool])).toBe(tool);
    expect(mrkFitted([tool])).toBe(false);
  });

  it("does not treat an MRK option line as replacing the standard MRK", () => {
    expect(markingToolReplacingMrk(["MRK"])).toBeNull();
    expect(mrkFitted(["MRK"])).toBe(true);
  });

  it("lists the tools in the order the form prints them", () => {
    expect(markingToolsAmong(["ABR", "IJP", "MRK"])).toEqual(["MRK", "IJP", "ABR"]);
    expect(MARKING_TOOL_ROLES).toEqual(["MRK", "IJP", "JTP", "ABR"]);
  });
});

describe("markingToolConflict", () => {
  it("passes a selection with one marking tool, or none", () => {
    expect(markingToolConflict(["HDC", "PM"])).toBeNull();
    expect(markingToolConflict(["IJP", "HDC"])).toBeNull();
    expect(markingToolConflict(["MRK"])).toBeNull();
  });

  it("refuses two at once, naming them as the form does", () => {
    expect(markingToolConflict(["MRK", "IJP"])).toContain("MRK, IJP");
    expect(markingToolConflict(["JTP", "ABR"])).toContain("JetPen, ABR");
    expect(markingToolConflict(["IJP", "ABR"])).toMatch(/only one marking tool/i);
  });

  it("names all of them when a quote somehow carries three", () => {
    expect(markingToolConflict(["MRK", "IJP", "ABR"])).toContain("MRK, IJP, ABR");
  });
});
