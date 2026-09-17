import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildPatches } from "../src/lib/production-forms/resolve";
import { patchWorkbook } from "../src/lib/production-forms/xlsx-patch";
import { readTemplate } from "../src/lib/production-forms/render";
import type { FormContext } from "../src/lib/production-forms/types";
import { formContext, formItem, formOption, xlsxForm } from "./helpers/fixtures";

// A fully-loaded order: a Punchline at a printed width, sold with a crate
// -- every value below is asserted on somewhere in this file, which is why
// it overrides so much of the shared fixture.
//
// The M-Series, EasyLoader, HDRF and EasyFeeder all moved off the workbook, so
// the end-to-end workbook-patching pipeline is exercised here against the
// Punchline form instead -- it is still an `XlsxFormSpec`, and its header
// values and role-driven ticks carry the same shape the earlier versions of
// this test used to cover.
const ctx: FormContext = formContext({
  company: {
    name: "Relaxvanguard",
    addressLines: ["12 Industrial Drive", "Dandenong South VIC 3175"],
    industry: "Automotive",
  },
  contact: { fullName: "John Smith", position: "Manager", phone: "+61 3 9999 0000", email: "j@e.com" },
  item: formItem({
    code: "P-220",
    name: "Punchline 220",
    kind: "FEEDER",
    form: "PUNCHLINE",
    specs: { widthCode: 220 },
    spec: {},
    options: [formOption("Crate-P", "CRATE")],
  }),
});

describe("production form pipeline", () => {
  it("produces a workbook carrying every expected value and tick", () => {
    const spec = xlsxForm("PUNCHLINE");
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    expect(xml).toContain("Pathfinder Australia Pty Ltd");
    expect(xml).toContain("Relaxvanguard");
    expect(xml).toContain("Automotive");

    // J28 the printed 220 width and D58 the crate -- one tick per role this
    // order actually carries.
    for (const cell of ["J28", "D58"]) {
      expect(xml, `expected a tick in ${cell}`).toMatch(
        new RegExp(`<c r="${cell}"[^>]*t="inlineStr"><is><t[^>]*>X</t>`),
      );
    }
  });

  it("leaves untouched every box the quote did not ask for", () => {
    const spec = xlsxForm("PUNCHLINE");
    const patched = patchWorkbook(readTemplate(spec.template), spec.sheetPath, buildPatches(spec, ctx));
    const xml = strFromU8(unzipSync(patched)[spec.sheetPath]);

    // H28 is the 180 width -- not ordered.
    for (const cell of ["H28"]) {
      expect(xml).not.toMatch(new RegExp(`<c r="${cell}"[^>]*t="inlineStr"`));
    }
  });
});
