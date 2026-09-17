import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { XCalibreForm } from "../src/components/forms/x-calibre-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formComponent } from "../src/components/forms/registry";
import { coveredRoles, resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { formContext, formItem } from "./helpers/fixtures";
import type { FormContext } from "../src/lib/production-forms/types";

const option = (code: string, role: string, qty = 1, attributes: Record<string, unknown> | null = null) =>
  ({ id: code, code, role, qty, attributes }) as never;

const ctx = (spec: Record<string, unknown> = {}, options: unknown[] = []) =>
  formContext({
    documentNumber: "Q-AU-2026-021",
    itemIndex: 1,
    itemCount: 2,
    generatedAt: new Date("2026-09-11T00:00:00Z"),
    logo: null,
    item: formItem({
      code: "X-10220",
      form: "X_CALIBRE",
      specs: { modelTier: "X10", widthCode: 220, cutWidthCm: 227, cutHeightCm: 10 },
      spec: { ui: "-Y", drills: { required: false, detail: "" }, ...spec },
      options: options as never,
    }),
  });

const render = (context: FormContext) =>
  renderToStaticMarkup(FormDocument({ children: XCalibreForm({ ctx: context }) }));

const marked = (html: string, state: "pf-on" | "pf-std"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

describe("the X-Calibre form", () => {
  it("prints one model box, because the catalogue sells one model", () => {
    const html = render(ctx());
    expect(marked(html, "pf-on")).toContain("X10");
    expect(html).not.toContain(">X3<");
    expect(html).not.toContain(">X5<");
    expect(html).not.toContain(">390<");
  });

  it("ticks the width the product is", () => {
    expect(marked(render(ctx()), "pf-on")).toContain("220");
  });

  it("marks IKA, AFP and HFV as fitted rather than chosen", () => {
    const standard = marked(render(ctx()), "pf-std").join(" | ");
    expect(standard).toContain("IKA");
    expect(standard).toContain("AFP");
    expect(standard).toContain("HFV");
    // Not in the "on" state: they were never sold, so nothing ticked them.
    expect(marked(render(ctx()), "pf-on")).not.toContain("IKA Ice Knife Air");
  });

  it("prints its one knife size as a standard, not as a question", () => {
    expect(marked(render(ctx()), "pf-std").join(" | ")).toContain("2.4 × 8.5");
  });

  it("ticks an option the customer bought", () => {
    expect(marked(render(ctx({}, [option("HDC-M", "HDC")])), "pf-on")).toContain("HDC Head Cam");
  });

  it("ticks the voltage from the production spec", () => {
    expect(marked(render(ctx({ voltage: "415V" })), "pf-on")).toContain("415V");
  });

  it("prints the MTS travel distance", () => {
    const html = render(ctx({}, [option("MTS", "MTS", 1, { metres: 14 })]));
    expect(html).toContain(">14</span>");
  });

  it("ticks a DuctMasTer rather than sending it to the Additional items sheet", () => {
    // X-Calibre gained a DMT box (2026-09-16): it is covered now, so a DMT
    // line no longer needs the Additional items sheet to be seen.
    const spec = resolveForm("X_CALIBRE")!;
    const context = ctx({}, [option("DMT", "DMT")]);

    expect(marked(render(context), "pf-on")).toContain("DMT DuctMasTer");
    expect(unmatchedOptions(spec, context).map((o) => o.code)).toEqual([]);
  });

  it("prints where the page came from", () => {
    expect(render(ctx())).toContain("X-CALIBRE · Q-AU-2026-021 · item 1 of 2 · 11.09.2026");
  });

  it("prints a box for every option role its spec claims to cover", () => {
    const spec = resolveForm("X_CALIBRE")!;
    const roles = [...coveredRoles(spec)].filter((role) => role !== "MTS_TRAVEL");
    // TRANSFORMER prints as TR220 or TR480, told apart by the option's code
    // rather than its role -- see PowerTicks in m-series-form.tsx.
    const options = roles.flatMap((role) =>
      role === "TRANSFORMER"
        ? [option("TR220-X", "TRANSFORMER"), option("TR480-X", "TRANSFORMER")]
        : [option(`opt-${role}`, role)]
    );
    const html = render(ctx({}, options));
    const on = marked(html, "pf-on").join(" | ");

    for (const role of roles) {
      if (role === "TRANSFORMER") {
        expect(on, role).toContain("TR220");
        expect(on, role).toContain("TR480");
        continue;
      }
      expect(on, role).toContain(role.replace("_", "-"));
    }
  });

  it("is registered", () => {
    expect(formComponent("X_CALIBRE")).toBe(XCalibreForm);
  });
});
