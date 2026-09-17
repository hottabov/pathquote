import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildPatches } from "../src/lib/production-forms/resolve";
import { patchWorkbook } from "../src/lib/production-forms/xlsx-patch";
import { readTemplate } from "../src/lib/production-forms/render";
import type { FormContext } from "../src/lib/production-forms/types";
import { formContext, formItem, formOption, xlsxForm } from "./helpers/fixtures";

// A fully-loaded order: an EasyFeeder at a printed width, sold with a crate
// -- every value below is asserted on somewhere in this file, which is why
// it overrides so much of the shared fixture.
//
// The M-Series and EasyLoader both moved off the workbook (2026-09-16), so
// the end-to-end workbook-patching pipeline is exercised here against the
// EasyFeed form instead -- it is still an `XlsxFormSpec`, and its header
// values, a rewritten label and a role-driven tick carry the same shape the
// earlier versions of this test used to cover.
const ctx: FormContext = formContext({
  company: {
    name: "Relaxvanguard",
    addressLines: ["12 Industrial Drive", "Dandenong South VIC 3175"],
    industry: "Automotive",
  },
  contact: { fullName: "John Smith", position: "Manager", phone: "+61 3 9999 0000", email: "j@e.com" },
  item: formItem({
    code: "EF-2420",
    name: "EasyFeed 2420",
    kind: "FEEDER",
    form: "EASYFEED",
    specs: { tableWidthMm: 2420 },
    spec: {},
    options: [formOption("Crate-EF", "CRATE")],
  }),
});

describe("production form pipeline", () => {
  it("produces a workbook carrying every expected value and tick", () => {
    const spec = xlsxForm("EASYFEED");
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    expect(xml).toContain("Pathfinder Australia Pty Ltd");
    expect(xml).toContain("Relaxvanguard");
    expect(xml).toContain("Automotive");

    // J28 the printed 2420 width and D60 the crate -- one tick per role this
    // order actually carries.
    for (const cell of ["J28", "D60"]) {
      expect(xml, `expected a tick in ${cell}`).toMatch(
        new RegExp(`<c r="${cell}"[^>]*t="inlineStr"><is><t[^>]*>X</t>`),
      );
    }
  });

  it("leaves untouched every box the quote did not ask for", () => {
    const spec = xlsxForm("EASYFEED");
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    // H28 is the 2020 width, L28 is the 3220 width, O28 is "Other?" -- none
    // was ordered.
    for (const cell of ["H28", "L28", "O28"]) {
      expect(xml).not.toMatch(new RegExp(`<c r="${cell}"[^>]*t="inlineStr"`));
    }
  });

  it("rewrites the width label for a size the row has no box for", () => {
    const custom = formContext({
      ...ctx,
      item: formItem({ ...ctx.item, specs: { tableWidthMm: 4030 } }),
    });
    const spec = xlsxForm("EASYFEED");
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, custom));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    expect(xml).toMatch(new RegExp(`<c r="O28"[^>]*t="inlineStr"><is><t[^>]*>X</t>`));
    expect(xml).toContain("Other?  4030mm");
  });
});
