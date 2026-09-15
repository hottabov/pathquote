import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MSeriesForm } from "../src/components/forms/m-series-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formComponent, isRenderable } from "../src/components/forms/registry";
import { coveredRoles, resolveForm } from "../src/lib/production-forms/resolve";
import { formContext, formItem } from "./helpers/fixtures";
import type { FormContext } from "../src/lib/production-forms/types";

const option = (code: string, role: string, qty = 1, attributes: Record<string, unknown> | null = null) =>
  ({ id: code, code, role, qty, attributes }) as never;

const ctx = (over: Partial<FormContext> = {}, spec: Record<string, unknown> = {}, options: unknown[] = []) =>
  formContext({
    documentNumber: "Q-AU-2026-014",
    itemIndex: 1,
    itemCount: 3,
    generatedAt: new Date("2026-09-11T00:00:00Z"),
    logo: null,
    item: formItem({
      code: "M-7220",
      form: "M_SERIES",
      specs: { modelTier: "M7", widthCode: 220, cutWidthCm: 227, cutHeightCm: 7 },
      spec: { ui: "-Y", knifeSize: "1.5x7.0", drills: { required: false, detail: "" }, ...spec },
      options: options as never,
    }),
    ...over,
  });

const render = (context: FormContext) => renderToStaticMarkup(FormDocument({ children: MSeriesForm({ ctx: context }) }));

/** The text of a tick that is switched on, so assertions read like the page. */
function ticked(html: string): string[] {
  return [...html.matchAll(/class="pf-tick[^"]*pf-on"[^>]*>(.*?)<\/label>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
}

describe("the M-Series form renders from the quote", () => {
  it("is one sheet carrying one stylesheet", () => {
    const html = render(ctx());
    expect(html.match(/pf-sheet"/g)?.length).toBe(1);
    expect(html.match(/<style>/g)?.length).toBe(1);
  });

  it("ticks the model and width the product is, and nothing else in those rows", () => {
    const marks = ticked(render(ctx()));
    expect(marks).toContain("M7");
    expect(marks).toContain("220");
    expect(marks).not.toContain("M5");
    expect(marks).not.toContain("300");
  });

  it("ticks VRB on every machine — it is fitted, not sold", () => {
    expect(ticked(render(ctx()))).toContain("VRB Vac Resealing Blind");
  });

  it("ticks an option the customer actually bought", () => {
    const withHdc = ticked(render(ctx({}, {}, [option("HDC-M", "HDC")])));
    expect(withHdc).toContain("HDC Head Cam");
    expect(ticked(render(ctx()))).not.toContain("HDC Head Cam");
  });

  it("ticks the voltage from the production spec, not from an option", () => {
    expect(ticked(render(ctx({}, { voltage: "415V" })))).toContain("415V");
  });

  it("prints the MTS travel distance beside its tick", () => {
    const html = render(ctx({}, {}, [option("MTS", "MTS", 1, { metres: 12 })]));
    expect(ticked(html)).toContain("MTS");
    expect(html).toContain(">12</span>");
  });

  it("leaves MTS untouched when none was sold", () => {
    expect(ticked(render(ctx()))).not.toContain("MTS");
  });

  it("ticks a PathWorks module only with the integrated licence", () => {
    const modules = [
      { code: "PTW-S", specs: { softwareMode: "standalone" } },
      { code: "PDG", specs: { pathworksModule: "PDG" } },
    ];
    expect(ticked(render(ctx({ software: modules as never })))).not.toContain("PDG PhotoDigitizer");

    const integrated = [
      { code: "PTW-I", specs: { softwareMode: "integrated" } },
      { code: "PDG", specs: { pathworksModule: "PDG" } },
    ];
    expect(ticked(render(ctx({ software: integrated as never })))).toContain("PDG PhotoDigitizer");
  });

  it("prints the drills answer and its detail", () => {
    const html = render(ctx({}, { drills: { required: true, detail: "4 × Ø3 mm carbide" } }));
    expect(ticked(html)).toContain("Yes");
    expect(html).toContain("4 × Ø3 mm carbide");
  });

  it("prints where the page came from", () => {
    const html = render(ctx());
    expect(html).toContain("M-SERIES · Q-AU-2026-014 · item 1 of 3 · generated 11.09.2026");
  });

  it("leaves the office-use fields blank — they are filled by hand", () => {
    const html = render(ctx());
    expect(html).toContain("Machine serial no.");
    expect(html).toContain("completed by hand in the workshop");
  });
});

describe("the component registry", () => {
  it("draws the M-Series", () => {
    expect(isRenderable("M_SERIES")).toBe(true);
    expect(formComponent("M_SERIES")).toBe(MSeriesForm);
  });

  it("prints a box for every option role its spec claims to cover", () => {
    // The spec's coverage list is what keeps a sold option off the
    // Additional items sheet. If the form stops printing a box the list
    // still claims, the option silently vanishes -- so the two are checked
    // against each other rather than trusted separately.
    const spec = resolveForm("M_SERIES")!;
    const html = render(
      ctx({}, {}, [...coveredRoles(spec)].map((role, i) => option(`opt-${i}`, role)))
    );
    const marks = ticked(html).join(" | ");

    for (const role of coveredRoles(spec)) {
      // MTS_TRAVEL prints as the metre figure beside MTS, not as its own box.
      if (role === "MTS_TRAVEL") continue;
      const code = role.replace("_", "-");
      expect(marks, role).toContain(code);
    }
  });
});
