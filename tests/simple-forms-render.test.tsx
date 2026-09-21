import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FabricTrolleyForm } from "../src/components/forms/fabric-trolley-form";
import { LeatherNestingForm, lnsModel } from "../src/components/forms/leather-nesting-form";
import { formComponent } from "../src/components/forms/registry";
import { resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import type { ProductionForm } from "@prisma/client";
import { formContext, formItem } from "./helpers/fixtures";

/**
 * The two sheets that ask nothing: the trolley (a header and the quantity)
 * and the Leather Nesting System (a fixed list of contents). Both were
 * workbook patches until 2026-09-18.
 */

const ctx = (code: string, form: ProductionForm, options: never[] = []) =>
  formContext({
    documentNumber: "Q-AU-2026-041",
    itemIndex: 1,
    itemCount: 1,
    generatedAt: new Date("2026-09-18T00:00:00Z"),
    logo: null,
    item: formItem({ code, form, kind: "ACCESSORY", specs: {}, spec: {}, options }),
  });

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("FabricPro Trolley form", () => {
  const html = renderToStaticMarkup(<FabricTrolleyForm ctx={ctx("FP-TROLLEY", "FP_TROLLEY")} />);

  it("is drawn by a component, not a workbook", () => {
    expect(resolveForm("FP_TROLLEY")?.renderer).toBe("html");
    expect(formComponent("FP_TROLLEY")).toBe(FabricTrolleyForm);
  });

  it("prints the quantity as 1, always — a second trolley is a second item line", () => {
    expect(text(html)).toContain("Quantity required 1");
  });

  it("has no tick boxes at all: nothing on this sheet is a choice", () => {
    expect(html).not.toContain("pf-tick");
  });

  it("prints the end user band and the provenance", () => {
    expect(html).toContain("End user");
    expect(text(html)).toContain("FABRIC-TROLLEY · Q-AU-2026-041 · item 1 of 1 · 18.09.2026");
  });
});

describe("Leather Nesting System form", () => {
  const html = renderToStaticMarkup(<LeatherNestingForm ctx={ctx("LNS-2420", "LNS")} />);

  it("is drawn by a component, not a workbook", () => {
    expect(resolveForm("LNS")?.renderer).toBe("html");
    expect(formComponent("LNS")).toBe(LeatherNestingForm);
  });

  it.each([
    ["LNS-2020", "2020"],
    ["LNS-2420", "2420"],
    ["LNS-3220", "3220"],
  ])("reads the static table width off the product code %s", (code, model) => {
    expect(lnsModel(code)).toBe(model);
    expect(text(renderToStaticMarkup(<LeatherNestingForm ctx={ctx(code, "LNS")} />))).toContain(
      `Static table ${model}`
    );
  });

  it("prints the label without a width when the code carries none, rather than inventing one", () => {
    const html = text(renderToStaticMarkup(<LeatherNestingForm ctx={ctx("LNS-CUSTOM", "LNS")} />));
    expect(lnsModel("LNS-CUSTOM")).toBeNull();
    expect(html).toContain("Static table ");
    expect(html).not.toMatch(/Static table \d/);
  });

  it("lists the system and the software the owner specified", () => {
    const body = text(html);
    for (const line of [
      "Operator console with utility drawer, including mounting bracket for the Pathfinder EasyLoader side frame",
      "Windows computer, keyboard, mouse and Microsoft Surface Dial",
      "Digital SLR camera and adjustable camera stand",
      "PathWorks™ (standalone) CAD software",
      "ANT-V6 — Automatic Nesting licence, optioned within PathWorks™",
      "WHD — Leather Hide Wizard",
    ]) {
      expect(body).toContain(line);
    }
  });

  it("asks nothing: no tick boxes and no production spec", () => {
    expect(html).not.toContain("pf-tick");
    expect(resolveForm("LNS")?.requires).toEqual([]);
  });
});

// Where the "every simple form: a crate sold with one is reported" case from
// the deleted tests/production-forms-simple.test.ts lives now. That file
// tested the xlsx engine against Punchline and went with it (2026-09-18);
// this assertion is about coverage, not about how the sheet is drawn, so it
// belongs beside the two sheets it is about.
describe("both sheets cover no option roles", () => {
  it.each([
    ["FP_TROLLEY", FabricTrolleyForm],
    ["LNS", LeatherNestingForm],
  ] as const)("%s sends any option it is ever sold with to the Additional items sheet", (form) => {
    const spec = resolveForm(form)!;
    expect(spec.covers).toEqual([]);
    const crate = { id: "c1", code: "Crate-X", role: "CRATE", qty: 1, attributes: null } as never;
    expect(unmatchedOptions(spec, ctx("X", form, [crate])).map((option) => option.code)).toEqual(["Crate-X"]);
  });
});
