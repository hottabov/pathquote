import { describe, it, expect } from "vitest";
import { ACT_WRITE_SWITCH_KEY, actWriteEnabled } from "../src/lib/act/write-switch";

describe("actWriteEnabled", () => {
  it("is off with no Setting row", () => {
    expect(actWriteEnabled(null)).toBe(false);
  });

  it("is on only for a stored JSON true", () => {
    expect(actWriteEnabled({ value: true })).toBe(true);
  });

  it("is off for anything else stored", () => {
    for (const value of [false, "true", 1, "1", "on", null, {}, [true], { enabled: true }]) {
      expect(actWriteEnabled({ value })).toBe(false);
    }
  });

  it("lives beside the sync's own keys", () => {
    expect(ACT_WRITE_SWITCH_KEY).toBe("act.write.enabled");
  });
});
