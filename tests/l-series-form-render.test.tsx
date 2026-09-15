import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LSeriesForm } from "../src/components/forms/l-series-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formComponent } from "../src/components/forms/registry";
import { formContext, formItem } from "./helpers/fixtures";
import type { FormContext } from "../src/lib/production-forms/types";

const option = (code: string, role: string, qty = 1) => ({ id: code, code, role, qty, attributes: null }) as never;

const ctx = (
  specs: Record<string, unknown> = {},
  spec: Record<string, unknown> = {},
  options: unknown[] = []
) =>
  formContext({
    documentNumber: "Q-AU-2026-033",
    itemIndex: 1,
    itemCount: 1,
    generatedAt: new Date("2026-09-11T00:00:00Z"),
    logo: null,
    item: formItem({
      code: "L-220F",
      form: "L_SERIES",
      specs: { widthCode: 220, cutWidthCm: 226, belt: "felt", extended: false, ...specs },
      spec: { ui: "-Y", ...spec },
      options: options as never,
    }),
  });

const render = (context: FormContext = ctx()) =>
  renderToStaticMarkup(FormDocument({ children: LSeriesForm({ ctx: context }) }));

const marked = (html: string, state: "pf-on" | "pf-std" | "pf-qty"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

describe("the L-Series form", () => {
  it("reads the model, cutting length and surface off the product code", () => {
    // L-220F is a 220 machine, standard length, felt belt -- none of it asked.
    const on = marked(render(), "pf-on").join(" | ");
    expect(on).toContain("L220");
    expect(on).toContain("175");
    expect(on).toContain("Felt");
    expect(on).not.toContain("Urethane");
  });

  it("reads the extended length off the same place", () => {
    const on = marked(render(ctx({ extended: true, belt: "urethane" })), "pf-on").join(" | ");
    expect(on).toContain("316");
    expect(on).toContain("Urethane");
  });

  it("marks MRK as standard on every machine", () => {
    expect(marked(render(), "pf-std").join(" | ")).toContain("MRK");
  });

  it("prints each tool sold, with a plain mark for one", () => {
    const html = render(ctx({}, {}, [option("NTT", "L_TOOL", 1)]));
    expect(marked(html, "pf-on").join(" | ")).toContain("NTT");
  });

  it("puts the quantity in the box when more than one was ordered", () => {
    const html = render(ctx({}, {}, [option("RKT-28", "L_TOOL", 2)]));
    expect(marked(html, "pf-qty").join(" | ")).toContain("RKT-28");
    expect(html).toContain('<span class="pf-q">2</span>');
  });

  it("says so plainly when no tools were ordered", () => {
    expect(render()).toContain("No tools ordered.");
  });

  it("prints a written-in voltage only when one was written in", () => {
    expect(render(ctx({}, { voltage: "other", voltageOtherVac: "380" }))).toContain(">380</span>");
    expect(marked(render(ctx({}, { voltage: "220/230" })), "pf-on").join(" | ")).toContain("220 / 230");
  });

  it("ticks the shipping mode chosen", () => {
    expect(marked(render(ctx({}, { shipping: "crate-whole" })), "pf-on").join(" | ")).toContain(
      "Wood crate, whole"
    );
  });

  it("keeps the fitting rules and consumables the paper form prints", () => {
    const html = render();
    expect(html).toContain("mutually exclusive");
    expect(html).toContain("#380019");
  });

  it("is dense — it is the one sheet that would otherwise run to two pages", () => {
    expect(render()).toContain('class="pf-sheet pf-dense"');
  });

  it("is registered", () => {
    expect(formComponent("L_SERIES")).toBe(LSeriesForm);
  });
});
