import { describe, it, expect } from "vitest";
import { buildPatches, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { easyFeedWidthCell } from "../src/lib/production-forms/specs/easyfeed";
import { formContext, formItem, xlsxForm } from "./helpers/fixtures";
import type { ProductionForm } from "@prisma/client";

const crate = { id: "crate", code: "Crate-EF", role: "CRATE" as const, qty: 1, attributes: null };

const ctx = (
  form: ProductionForm,
  specs: Record<string, unknown>,
  spec: Record<string, unknown> = {},
  options = [crate]
) => formContext({ item: formItem({ form, specs, spec, options }) });

const cells = (form: ProductionForm, specs: Record<string, unknown>, spec = {}, options = [crate]) => {
  const patches = buildPatches(xlsxForm(form), ctx(form, specs, spec, options));
  return Object.fromEntries(patches.map((patch) => [patch.cell, patch.value]));
};

describe("the shared machine-sale header", () => {
  // EasyFeed, HDRF, Punchline and the Fabric Trolley were drawn from one
  // master, so one assertion covers the header on all four.
  it.each(["EASYFEED", "HDRF", "PUNCHLINE", "FP_TROLLEY"] as const)("fills %s", (form) => {
    const written = cells(form, {});

    expect(written.G10).toBe("Pathfinder Australia Pty Ltd");
    expect(written.O10).toBe("Vadym H");
    expect(written.I14).toBe("Relaxvanguard");
    expect(written.I15).toBe("12 Industrial Dr");
    expect(written.I18).toBe("John Smith");
    expect(written.I22).toBe("j@example.com");
    expect(written.I23).toBe("Automotive");
  });
});

describe("EasyFeed", () => {
  it.each([
    [2020, "H28"],
    [2420, "J28"],
    [3220, "L28"],
  ])("ticks the printed box for a %i table", (tableWidthMm, cell) => {
    expect(easyFeedWidthCell({ tableWidthMm })).toBe(cell);
    expect(cells("EASYFEED", { tableWidthMm })[cell]).toBe("X");
  });

  it("falls back to the Other box and writes the width over its label", () => {
    const written = cells("EASYFEED", { tableWidthMm: 4030 });

    expect(written.O28).toBe("X");
    expect(written.P28).toBe("Other?  4030mm");
    expect(written.H28).toBeUndefined();
  });

  it("leaves the Other label alone for a width with a box of its own", () => {
    expect(cells("EASYFEED", { tableWidthMm: 2020 }).P28).toBeUndefined();
  });

  it("leaves Ex-Works blank -- delivery terms belong to logistics -- and still ticks the crate from the option", () => {
    // D48 (Ex-Works) was removed (2026-09-16): it is not printed from any
    // spec answer any more, so it is always blank.
    expect(cells("EASYFEED", { tableWidthMm: 2020 }).D48).toBeUndefined();
    expect(cells("EASYFEED", { tableWidthMm: 2020 }, { exWorks: true }).D48).toBeUndefined();
    expect(cells("EASYFEED", { tableWidthMm: 2020 }).D60).toBe("X");
  });
});

describe("HDRF", () => {
  it.each([
    [180, "H28"],
    [220, "J28"],
    // The third label sits in N28 and its box in M28, not the narrow column
    // the other two use. Confirmed against a rendered page.
    [320, "M28"],
  ])("ticks the box for HDRF%i", (widthCode, cell) => {
    expect(cells("HDRF", { widthCode })[cell]).toBe("X");
  });

  it("ticks no model box for a product with no width spec", () => {
    const written = cells("HDRF", {});
    expect([written.H28, written.J28, written.M28]).toEqual([undefined, undefined, undefined]);
  });
});

describe("Punchline", () => {
  it.each([
    [180, "H28"],
    [220, "J28"],
  ])("ticks the box for P-%i", (widthCode, cell) => {
    expect(cells("PUNCHLINE", { widthCode })[cell]).toBe("X");
  });
});

describe("FabricPro Trolley", () => {
  it("prints a quantity of one — one item is one machine", () => {
    expect(cells("FP_TROLLEY", {}).H28).toBe("1");
  });
});

describe("Leather Nesting Station", () => {
  const written = cells("LNS", {});

  it("ticks its single box", () => {
    expect(written.D24).toBe("X");
  });

  it("joins the address tail into the second of its two rows", () => {
    const full = buildPatches(
      xlsxForm("LNS"),
      formContext({
        company: {
          name: "Relaxvanguard",
          addressLines: ["12 Industrial Dr", "Dandenong VIC 3175", "Australia"],
          industry: "Automotive",
        },
        item: formItem({ form: "LNS", specs: {}, spec: {} }),
      })
    );
    const map = Object.fromEntries(full.map((patch) => [patch.cell, patch.value]));

    expect(map.G12).toBe("12 Industrial Dr");
    expect(map.G13).toBe("Dandenong VIC 3175, Australia");
  });

});

describe("every simple form", () => {
  it.each(["EASYFEED", "HDRF", "PUNCHLINE"] as const)(
    "%s keeps its crate off the Additional items sheet",
    (form) => {
      expect(unmatchedOptions(xlsxForm(form), ctx(form, {}))).toEqual([]);
    }
  );

  it.each(["FP_TROLLEY", "LNS"] as const)("%s has no crate box, so a crate is reported", (form) => {
    expect(unmatchedOptions(xlsxForm(form), ctx(form, {})).map((o) => o.code)).toEqual(["Crate-EF"]);
  });
});
