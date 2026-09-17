import { describe, it, expect } from "vitest";
import { buildPatches, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { formContext, formItem, xlsxForm } from "./helpers/fixtures";
import type { ProductionForm } from "@prisma/client";

const crate = { id: "crate", code: "Crate-P", role: "CRATE" as const, qty: 1, attributes: null };

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
  // Punchline and the Fabric Trolley were drawn from one master (with
  // EasyFeed and HDRF, now HTML forms), so one assertion covers the header.
  it.each(["PUNCHLINE", "FP_TROLLEY"] as const)("fills %s", (form) => {
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
  it.each(["PUNCHLINE"] as const)(
    "%s keeps its crate off the Additional items sheet",
    (form) => {
      expect(unmatchedOptions(xlsxForm(form), ctx(form, {}))).toEqual([]);
    }
  );

  it.each(["FP_TROLLEY", "LNS"] as const)("%s has no crate box, so a crate is reported", (form) => {
    expect(unmatchedOptions(xlsxForm(form), ctx(form, {})).map((o) => o.code)).toEqual(["Crate-P"]);
  });
});
