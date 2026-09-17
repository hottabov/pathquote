import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { easyLoaderSpecSchema } from "../src/lib/validation/production-spec";
import { MSeriesForm } from "../src/components/forms/m-series-form";
import { EasyLoaderForm } from "../src/components/forms/easyloader-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formContext, formItem } from "./helpers/fixtures";

const marked = (html: string, state: "pf-on" | "pf-std"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

const renderEl = (spec: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    FormDocument({
      children: EasyLoaderForm({
        ctx: formContext({
          item: formItem({
            form: "EASYLOADER",
            specs: { tableWidthMm: 2420 },
            spec: { ui: "-Y", usage: "onload", sections: [], ...spec },
          }),
        }),
      }),
    })
  );

describe("VRB is standard fitment, not an option", () => {
  // The M-Series moved off the workbook (2026-09-16): it is drawn by
  // `MSeriesForm` now, so "printed" is checked in the rendered markup rather
  // than by a cell address, and "covered" is checked against `resolveForm`
  // directly since `unmatchedOptions` takes either kind of `FormSpec`.
  it("prints ticked on every M-Series form, with no VRB line on the quote", () => {
    const html = renderToStaticMarkup(
      FormDocument({ children: MSeriesForm({ ctx: formContext({ item: formItem({ form: "M_SERIES" }) }) }) })
    );
    const std = [...html.matchAll(/class="pf-tick[^"]*pf-std"[^>]*>(.*?)<\/label>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    expect(std).toContain("VRB Vac Resealing Blind");
  });

  it("does not claim to cover a VRB line, so an unexpected one still surfaces", () => {
    const vrb = { id: "o", code: "VRB-M", role: "VRB" as const, qty: 1, attributes: null };
    const ctx = formContext({ item: formItem({ form: "M_SERIES", options: [vrb] }) });

    expect(unmatchedOptions(resolveForm("M_SERIES")!, ctx).map((o) => o.code)).toEqual(["VRB-M"]);
  });
});

describe("EasyLoader synchronisation with the cutter", () => {
  it("defaults to yes when the spec has never been touched", () => {
    expect(easyLoaderSpecSchema.parse({}).syncWithCutter).toBe(true);
    expect(marked(renderEl(), "pf-on")).toContain("Synchronisation feature with Pathfinder cutter");
  });

  it("prints ticked when it is on", () => {
    expect(marked(renderEl({ syncWithCutter: true }), "pf-on")).toContain(
      "Synchronisation feature with Pathfinder cutter"
    );
  });

  it("prints nothing only when a manager unticked it", () => {
    expect(marked(renderEl({ syncWithCutter: false }), "pf-on")).not.toContain(
      "Synchronisation feature with Pathfinder cutter"
    );
  });
});
