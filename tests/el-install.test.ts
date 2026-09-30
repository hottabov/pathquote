import { describe, it, expect } from "vitest";
import { easyLoaderInstallHours, formatInstallHours } from "../src/lib/production-forms/el-install";

const conveyor = (modules: number) => ({ lengthM: modules * 1.2, surface: "conveyor" as const });
const stat = (modules: number) => ({ lengthM: modules * 1.2, surface: "static" as const });

describe("easyLoaderInstallHours", () => {
  it("prices Vadym's worked example: 6 + 3 conveyor, 1 static = 10 hours", () => {
    // 2 drive modules x 2 h + (5 + 2 + 1) other modules x 0.75 h
    expect(easyLoaderInstallHours([conveyor(6), conveyor(3), stat(1)])).toBe(10);
  });

  it("gives every conveyor section its own drive module", () => {
    expect(easyLoaderInstallHours([conveyor(1)])).toBe(2);
    expect(easyLoaderInstallHours([conveyor(1), conveyor(1)])).toBe(4);
  });

  it("counts static modules at the additional-module rate", () => {
    expect(easyLoaderInstallHours([stat(4)])).toBe(3);
  });

  it("is exact in quarter hours", () => {
    expect(easyLoaderInstallHours([conveyor(4)])).toBe(4.25);
  });

  it("is nothing for a table not yet drawn", () => {
    expect(easyLoaderInstallHours([])).toBe(0);
  });
});

describe("formatInstallHours", () => {
  it("reads naturally", () => {
    expect(formatInstallHours(10)).toBe("10 hrs");
    expect(formatInstallHours(1)).toBe("1 hr");
    expect(formatInstallHours(4.25)).toBe("4.25 hrs");
  });
});
