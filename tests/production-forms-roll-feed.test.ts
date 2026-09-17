import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { EasyLoaderForm } from "../src/components/forms/easyloader-form";
import { FormDocument } from "../src/components/forms/form-sheet";
import { formContext, formItem } from "./helpers/fixtures";

const elForm = resolveForm("EASYLOADER")!;

const rollFeedOption = (qty: number) => ({
  id: "opt-rf",
  code: "EL-2420-RF",
  role: "EL_ROLL_FEED" as const,
  qty,
  attributes: null,
});

const context = (options: ReturnType<typeof rollFeedOption>[], distancesMm?: number[]) =>
  formContext({
    item: formItem({
      code: "EL-2420",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: {
        usage: "onload",
        sections: [{ lengthM: 2.4, surface: "conveyor" }],
        ...(distancesMm ? { rollFeedDistancesMm: distancesMm } : {}),
      },
      options,
    }),
  });

const render = (options: ReturnType<typeof rollFeedOption>[], distancesMm?: number[]) =>
  renderToStaticMarkup(FormDocument({ children: EasyLoaderForm({ ctx: context(options, distancesMm) }) }));

const marked = (html: string, state: "pf-on" | "pf-std"): string[] =>
  [...html.matchAll(new RegExp(`class="pf-tick[^"]*${state}"[^>]*>(.*?)</label>`, "g"))].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );

describe("EasyLoader roll feed", () => {
  it("ticks the row and prints the quantity from the option line, not the spec", () => {
    const html = render([rollFeedOption(2)], [300, 1500]);

    expect(marked(html, "pf-on")).toContain(
      "Single roll feed attachment — EL-2020 / EL-2420 only, includes side keepers"
    );
    expect(html).toContain(">2</span>");
  });

  it("prints each distance in its own printed row", () => {
    const html = render([rollFeedOption(3)], [300, 1500, 2700]);
    const rows = [...html.matchAll(/#(\d)<\/span><span class="pf-run pf-short">(\d*)<\/span>/g)].map(
      (m) => [m[1], m[2]]
    );

    expect(rows).toEqual([
      ["1", "300"],
      ["2", "1500"],
      ["3", "2700"],
      ["4", ""],
    ]);
  });

  it("leaves the row untouched when no attachment was sold", () => {
    const html = render([]);

    expect(marked(html, "pf-on")).not.toContain(
      "Single roll feed attachment — EL-2020 / EL-2420 only, includes side keepers"
    );
    expect(html).not.toContain("Distance from X = 0");
  });

  it("keeps a sold attachment off the Additional items sheet", () => {
    const unmatched = unmatchedOptions(elForm, context([rollFeedOption(1)]));

    expect(unmatched.map((option) => option.code)).toEqual([]);
  });

  it("still prints the distances a spec carries for an attachment bought earlier", () => {
    // The customer owns the attachment already, so no option line -- the row
    // is not ticked, but the distances the service crew needs still print.
    const html = render([], [300]);

    expect(marked(html, "pf-on")).not.toContain(
      "Single roll feed attachment — EL-2020 / EL-2420 only, includes side keepers"
    );
    expect(html).toContain("Distance from X = 0");
    expect(html).toContain(">300</span>");
  });
});
